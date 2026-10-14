//! Microphone capture through cpal, normalized to 16 kHz mono 16 bit PCM.
//!
//! The cpal stream is not Send, so it lives on its own thread; the Recorder
//! handle only holds the shared buffer and a stop channel and can therefore be
//! moved between threads by the pipeline.

use std::io::Cursor;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::FromSample;

use crate::model::MicDevice;

const TARGET_RATE: u32 = 16_000;
/// One level callback per 50 ms: about 20 per second.
const LEVEL_CHUNK: usize = (TARGET_RATE as usize) / 20;
/// How long opening the microphone may take before the start gives up.
const MIC_OPEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);

pub struct Recorder {
    buffer: Arc<Mutex<Vec<i16>>>,
    peak: Arc<AtomicU32>,
    /// Samples already handed out by `take_segment`, for the total duration.
    taken: AtomicU64,
    stop: Option<mpsc::Sender<()>>,
    handle: Option<JoinHandle<()>>,
}

impl Recorder {
    pub fn start(
        device_name: &str,
        on_level: impl Fn(f32) + Send + 'static,
    ) -> Result<Recorder, String> {
        let buffer: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::with_capacity(
            TARGET_RATE as usize * 10,
        )));
        let peak = Arc::new(AtomicU32::new(0));

        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let thread_buffer = Arc::clone(&buffer);
        let thread_peak = Arc::clone(&peak);
        let wanted = device_name.to_string();

        let handle = std::thread::spawn(move || {
            match build_stream(&wanted, thread_buffer, thread_peak, on_level) {
                Ok(stream) => {
                    if let Err(error) = stream.play() {
                        let _ = ready_tx.send(Err(format!("Could not start the microphone: {error}")));
                        return;
                    }
                    let _ = ready_tx.send(Ok(()));
                    // Block until stop() drops the sender or sends a signal.
                    let _ = stop_rx.recv();
                    drop(stream);
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                }
            }
        });

        // A device that never answers (a Bluetooth headset switching profiles,
        // a stuck audio driver) must not block the caller forever: the hotkey
        // worker calls this, and a hang there made every later hotkey dead.
        // On timeout `stop_tx` is dropped with this frame, so a stream that
        // opens late ends right away instead of recording in the background.
        match ready_rx.recv_timeout(MIC_OPEN_TIMEOUT) {
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err("The microphone did not respond. Check that it is connected and not used exclusively by another app.".to_string())
            }
            Ok(Ok(())) => Ok(Recorder {
                buffer,
                peak,
                taken: AtomicU64::new(0),
                stop: Some(stop_tx),
                handle: Some(handle),
            }),
            Ok(Err(error)) => Err(error),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("The microphone thread stopped unexpectedly.".to_string())
            }
        }
    }

    fn samples(&self) -> std::sync::MutexGuard<'_, Vec<i16>> {
        match self.buffer.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// WAV of at most the last `max_secs` seconds since the start or the last
    /// `take_segment`, for the live transcript. The flag says whether older
    /// audio was left out. Does not stop the recording.
    pub fn snapshot_tail_wav(&self, max_secs: u32) -> (Vec<u8>, bool) {
        let tail = {
            let samples = self.samples();
            let (from, cut) = tail_start(samples.len(), max_secs);
            (samples[from..].to_vec(), cut)
        };
        (encode_wav(&tail.0), tail.1)
    }

    /// Hands-free segments without a gap: returns everything since the start
    /// or the last call as WAV while the microphone keeps running. The cut
    /// lands in the quietest 30 ms within the last 2 s, so it falls between
    /// words; the audio after the cut stays for the next segment (or `stop`).
    pub fn take_segment(&self) -> Vec<u8> {
        let segment = split_segment(&mut self.samples());
        self.taken.fetch_add(segment.len() as u64, Ordering::Relaxed);
        encode_wav(&segment)
    }

    /// Stops the stream and returns the WAV since the last `take_segment` (the
    /// whole recording if there was none) plus the duration of the whole
    /// recording in ms, taken segments included.
    pub fn stop(mut self) -> (Vec<u8>, u64) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        let samples = self.samples().clone();
        let total = self.taken.load(Ordering::Relaxed) + samples.len() as u64;
        let duration_ms = (total * 1000) / TARGET_RATE as u64;
        (encode_wav(&samples), duration_ms)
    }

    /// Throw away everything recorded so far. The microphone preview keeps no
    /// audio at all, so its buffer must not grow while the meter is open.
    pub fn discard(&self) {
        self.samples().clear();
    }

    /// Highest RMS seen over the whole recording, taken segments included,
    /// for the silence check.
    pub fn peak_rms(&self) -> f32 {
        f32::from_bits(self.peak.load(Ordering::Relaxed))
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

// ------------------------------------------------------------------ silence

/// Windows below this RMS count as silence. Same threshold the pipeline uses
/// for the whole-recording check.
pub const SILENCE_RMS: f32 = 0.01;
/// Analysis window: 50 ms, same resolution as the level meter.
const SILENCE_WINDOW: usize = LEVEL_CHUNK;
/// Silence kept before the first and after the last speech window so word
/// edges are not clipped.
const EDGE_PAD: usize = 8;
/// An interior silence longer than this many windows (1.5 s) is compressed:
/// Whisper invents text on long quiet stretches.
const MAX_GAP: usize = 30;
/// What a compressed gap keeps on each side (400 ms).
const GAP_KEEP: usize = 8;

/// Decode a WAV we encoded ourselves back to 16 kHz mono samples.
pub fn decode_wav(wav: &[u8]) -> Vec<i16> {
    let cursor = Cursor::new(wav);
    let Ok(mut reader) = hound::WavReader::new(cursor) else {
        return Vec::new();
    };
    reader.samples::<i16>().map(|s| s.unwrap_or(0)).collect()
}

/// RMS of every 50 ms window in the buffer.
fn window_rms(samples: &[i16]) -> Vec<f32> {
    samples
        .chunks(SILENCE_WINDOW)
        .map(|window| {
            let sum: f64 = window
                .iter()
                .map(|&s| {
                    let v = f64::from(s) / 32768.0;
                    v * v
                })
                .sum();
            (sum / window.len() as f64).sqrt() as f32
        })
        .collect()
}

/// Share of 50 ms windows holding speech-level audio. Low values mean the
/// recording is mostly silence or noise, where Whisper tends to hallucinate.
pub fn speech_fraction(wav: &[u8]) -> f32 {
    let rms = window_rms(&decode_wav(wav));
    if rms.is_empty() {
        return 0.0;
    }
    let speech = rms.iter().filter(|&&r| r >= SILENCE_RMS).count();
    speech as f32 / rms.len() as f32
}

/// Remove silence: the edges are trimmed and interior gaps longer than
/// MAX_GAP are compressed to GAP_KEEP on both sides. An empty result means
/// the recording holds nothing audible and must not reach the transcriber.
pub fn trim_silence(wav: &[u8]) -> Vec<u8> {
    let samples = decode_wav(wav);
    let rms = window_rms(&samples);
    let Some(first) = rms.iter().position(|&r| r >= SILENCE_RMS) else {
        return Vec::new();
    };
    let last = rms.iter().rposition(|&r| r >= SILENCE_RMS).unwrap();
    let start = first.saturating_sub(EDGE_PAD);
    let end = (last + EDGE_PAD + 1).min(rms.len());

    let mut keep = vec![false; rms.len()];
    let mut i = start;
    while i < end {
        if rms[i] >= SILENCE_RMS {
            keep[i] = true;
            i += 1;
            continue;
        }
        let gap_start = i;
        while i < end && rms[i] < SILENCE_RMS {
            i += 1;
        }
        let gap_end = i;
        if gap_end - gap_start <= MAX_GAP {
            for k in gap_start..gap_end {
                keep[k] = true;
            }
        } else {
            for k in gap_start..(gap_start + GAP_KEEP).min(gap_end) {
                keep[k] = true;
            }
            for k in gap_end.saturating_sub(GAP_KEEP).max(gap_start)..gap_end {
                keep[k] = true;
            }
        }
    }

    let mut kept: Vec<i16> = Vec::with_capacity(samples.len());
    for (window, chunk) in keep.iter().zip(samples.chunks(SILENCE_WINDOW)) {
        if *window {
            kept.extend_from_slice(chunk);
        }
    }
    if kept.is_empty() {
        return Vec::new();
    }
    encode_wav(&kept)
}

// ------------------------------------------------------------------ segments

/// Candidate window for a segment cut: 30 ms.
const CUT_WINDOW: usize = TARGET_RATE as usize * 30 / 1000;
/// Step between candidate windows: 10 ms.
const CUT_STEP: usize = TARGET_RATE as usize / 100;
/// How far back from the end of the buffer a segment cut may land: 2 s.
const CUT_SEARCH: usize = TARGET_RATE as usize * 2;

/// Where to cut a running recording: the middle of the quietest 30 ms window
/// between `search_from` and the end, so the cut falls into a pause or at
/// least a quiet consonant instead of the middle of a vowel. On a tie the
/// later window wins, so the current segment keeps as much as possible.
/// A search range shorter than one window cuts at the very end.
pub fn quiet_cut_index(samples: &[i16], search_from: usize) -> usize {
    let len = samples.len();
    let from = search_from.min(len);
    if len - from < CUT_WINDOW {
        return len;
    }
    let mut best_start = from;
    let mut best_energy = u64::MAX;
    let mut start = from;
    while start + CUT_WINDOW <= len {
        let energy: u64 = samples[start..start + CUT_WINDOW]
            .iter()
            .map(|&s| {
                let v = i64::from(s);
                (v * v) as u64
            })
            .sum();
        if energy <= best_energy {
            best_energy = energy;
            best_start = start;
        }
        start += CUT_STEP;
    }
    best_start + CUT_WINDOW / 2
}

/// Where the last `max_secs` seconds of a buffer of `len` samples begin, and
/// whether anything before them is left out.
fn tail_start(len: usize, max_secs: u32) -> (usize, bool) {
    let window = TARGET_RATE as usize * max_secs as usize;
    if len > window {
        (len - window, true)
    } else {
        (0, false)
    }
}

/// Remove and return the samples up to the quiet cut within the last
/// CUT_SEARCH samples; what follows the cut stays in `buffer`.
fn split_segment(buffer: &mut Vec<i16>) -> Vec<i16> {
    let cut = quiet_cut_index(buffer, buffer.len().saturating_sub(CUT_SEARCH));
    buffer.drain(..cut).collect()
}

// ------------------------------------------------------------------ encoding

/// 16 kHz mono 16 bit WAV, the format every transcriber gets.
pub fn encode_wav(samples: &[i16]) -> Vec<u8> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = Cursor::new(Vec::<u8>::new());
    {
        let mut writer = match hound::WavWriter::new(&mut cursor, spec) {
            Ok(writer) => writer,
            Err(_) => return Vec::new(),
        };
        for sample in samples {
            if writer.write_sample(*sample).is_err() {
                break;
            }
        }
        let _ = writer.finalize();
    }
    cursor.into_inner()
}

// ------------------------------------------------------------------ capture

fn pick_device(wanted: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if !wanted.is_empty() {
        if let Ok(devices) = host.input_devices() {
            for device in devices {
                if device.name().map(|n| n == wanted).unwrap_or(false) {
                    return Ok(device);
                }
            }
        }
    }
    host.default_input_device()
        .ok_or_else(|| "No microphone found.".to_string())
}

fn build_stream(
    wanted: &str,
    buffer: Arc<Mutex<Vec<i16>>>,
    peak: Arc<AtomicU32>,
    on_level: impl Fn(f32) + Send + 'static,
) -> Result<cpal::Stream, String> {
    let device = pick_device(wanted)?;
    let config = device
        .default_input_config()
        .map_err(|error| format!("Microphone config unavailable: {error}"))?;
    let sample_format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();

    match sample_format {
        cpal::SampleFormat::F32 => run::<f32>(&device, &stream_config, buffer, peak, on_level),
        cpal::SampleFormat::I16 => run::<i16>(&device, &stream_config, buffer, peak, on_level),
        cpal::SampleFormat::U16 => run::<u16>(&device, &stream_config, buffer, peak, on_level),
        cpal::SampleFormat::I32 => run::<i32>(&device, &stream_config, buffer, peak, on_level),
        cpal::SampleFormat::I8 => run::<i8>(&device, &stream_config, buffer, peak, on_level),
        cpal::SampleFormat::U8 => run::<u8>(&device, &stream_config, buffer, peak, on_level),
        other => Err(format!("Unsupported microphone sample format: {other}")),
    }
}

/// Level curve: raw RMS is tiny for normal speech, so lift it with a soft knee.
fn level_from_rms(rms: f32) -> f32 {
    let lifted = ((rms - 0.002).max(0.0) * 15.0).clamp(0.0, 1.0);
    lifted.powf(0.7)
}

fn run<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    buffer: Arc<Mutex<Vec<i16>>>,
    peak: Arc<AtomicU32>,
    on_level: impl Fn(f32) + Send + 'static,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    let source_rate = config.sample_rate.0.max(1) as f64;
    let ratio = source_rate / TARGET_RATE as f64;

    // Resampler state, kept across callbacks.
    let mut frame_index: f64 = 0.0;
    let mut next_out: f64 = 0.0;
    let mut previous: f32 = 0.0;
    // Level accumulator.
    let mut square_sum: f64 = 0.0;
    let mut square_count: usize = 0;

    let mut converted: Vec<i16> = Vec::with_capacity(4096);

    let error_callback = |error| log::warn!("microphone stream error: {error}");

    let stream = device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                converted.clear();
                for frame in data.chunks(channels) {
                    let mut mono = 0.0f32;
                    for sample in frame {
                        mono += f32::from_sample_(*sample);
                    }
                    mono /= frame.len().max(1) as f32;

                    // Emit every output sample that falls between the previous
                    // and the current input frame (linear interpolation).
                    while next_out <= frame_index {
                        let t = (next_out - (frame_index - 1.0)).clamp(0.0, 1.0) as f32;
                        let value = previous + (mono - previous) * t;
                        converted.push((value.clamp(-1.0, 1.0) * 32767.0) as i16);
                        square_sum += (value * value) as f64;
                        square_count += 1;
                        next_out += ratio;
                    }
                    previous = mono;
                    frame_index += 1.0;
                }

                if !converted.is_empty() {
                    if let Ok(mut guard) = buffer.lock() {
                        guard.extend_from_slice(&converted);
                    }
                }

                while square_count >= LEVEL_CHUNK {
                    let rms = (square_sum / square_count as f64).sqrt() as f32;
                    square_sum = 0.0;
                    square_count = 0;
                    let previous_peak = f32::from_bits(peak.load(Ordering::Relaxed));
                    if rms > previous_peak {
                        peak.store(rms.to_bits(), Ordering::Relaxed);
                    }
                    on_level(level_from_rms(rms));
                }
            },
            error_callback,
            None,
        )
        .map_err(|error| format!("Could not open the microphone: {error}"))?;

    Ok(stream)
}

// ------------------------------------------------------------------ devices

pub fn list_devices() -> Vec<MicDevice> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|device| device.name().ok())
        .unwrap_or_default();

    let mut out = Vec::new();
    if let Ok(devices) = host.input_devices() {
        for device in devices {
            if let Ok(name) = device.name() {
                let is_default = name == default_name;
                if !out.iter().any(|d: &MicDevice| d.name == name) {
                    out.push(MicDevice { name, is_default });
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loud_samples(count: usize) -> Vec<i16> {
        vec![16_000; count]
    }

    #[test]
    fn trim_silence_drops_a_recording_without_speech() {
        let silence = encode_wav(&vec![0; TARGET_RATE as usize]);
        assert!(trim_silence(&silence).is_empty());
    }

    #[test]
    fn trim_silence_cuts_the_quiet_tail() {
        // Half a second of signal, then two seconds of silence.
        let mut samples = loud_samples(8000);
        samples.extend_from_slice(&vec![0; (TARGET_RATE as usize) * 2]);
        let decoded = decode_wav(&trim_silence(&encode_wav(&samples)));
        assert!(decoded.len() >= 8000);
        // Speech plus at most the edge pad and one window of slack.
        assert!(decoded.len() <= 8000 + (EDGE_PAD + 1) * SILENCE_WINDOW);
    }

    #[test]
    fn trim_silence_keeps_short_pauses_and_compresses_long_ones() {
        // 0.5 s speech, 0.5 s pause, 0.5 s speech, 4 s pause, 0.5 s speech.
        let mut samples = loud_samples(8000);
        samples.extend_from_slice(&vec![0; 8000]);
        samples.extend_from_slice(&loud_samples(8000));
        samples.extend_from_slice(&vec![0; (TARGET_RATE as usize) * 4]);
        samples.extend_from_slice(&loud_samples(8000));
        let decoded = decode_wav(&trim_silence(&encode_wav(&samples)));
        // The 0.5 s pause survives whole, the 4 s pause shrinks to 2 * GAP_KEEP.
        assert!(decoded.len() <= 8000 * 3 + (EDGE_PAD + GAP_KEEP * 2 + 2) * SILENCE_WINDOW);
        assert!(decoded.len() >= 8000 * 3 + 8000);
    }

    #[test]
    fn speech_fraction_counts_loud_windows() {
        let mut samples = loud_samples(8000);
        samples.extend_from_slice(&vec![0; 8000]);
        assert_eq!(speech_fraction(&encode_wav(&samples)), 0.5);
    }

    #[test]
    fn quiet_cut_index_finds_the_pause() {
        // 1 s speech, 100 ms pause, 1 s speech: the cut lands inside the pause.
        let mut samples = loud_samples(16_000);
        samples.extend_from_slice(&vec![0; 1600]);
        samples.extend_from_slice(&loud_samples(16_000));
        let cut = quiet_cut_index(&samples, 0);
        assert!((16_000..16_000 + 1600).contains(&cut), "cut at {cut}");
    }

    #[test]
    fn quiet_cut_index_prefers_the_quieter_spot_and_the_later_tie() {
        // Loud, a soft stretch, loud, a silent stretch, loud.
        let mut samples = loud_samples(4800);
        samples.extend_from_slice(&vec![2000; 1600]);
        samples.extend_from_slice(&loud_samples(4800));
        samples.extend_from_slice(&vec![0; 1600]);
        samples.extend_from_slice(&loud_samples(4800));
        let cut = quiet_cut_index(&samples, 0);
        assert!((11_200..12_800).contains(&cut), "cut at {cut}");

        // All silent: the latest window wins.
        let silent = vec![0i16; 16_000];
        let cut = quiet_cut_index(&silent, 0);
        assert!(cut >= 16_000 - CUT_WINDOW - CUT_STEP, "cut at {cut}");
    }

    #[test]
    fn quiet_cut_index_respects_search_from_and_short_ranges() {
        // A pause before search_from is ignored.
        let mut samples = vec![0; 1600];
        samples.extend_from_slice(&loud_samples(16_000));
        assert!(quiet_cut_index(&samples, 8000) >= 8000);
        // Nothing (or less than one window) to search: cut at the end.
        assert_eq!(quiet_cut_index(&samples, samples.len()), samples.len());
        assert_eq!(quiet_cut_index(&samples, samples.len() + 10), samples.len());
        assert_eq!(quiet_cut_index(&samples, samples.len() - 10), samples.len());
        assert_eq!(quiet_cut_index(&[], 0), 0);
    }

    #[test]
    fn tail_start_keeps_only_the_last_seconds() {
        let rate = TARGET_RATE as usize;
        assert_eq!(tail_start(0, 20), (0, false));
        assert_eq!(tail_start(rate * 20, 20), (0, false));
        assert_eq!(tail_start(rate * 20 + 1, 20), (1, true));
        assert_eq!(tail_start(rate * 55, 20), (rate * 35, true));
    }

    #[test]
    fn split_segment_loses_no_sample() {
        // 60 s of speech bursts with short, slightly noisy pauses of varying length.
        let mut buffer: Vec<i16> = Vec::new();
        for i in 0..60usize {
            let loud = 14_400 + (i * 37) % 800;
            buffer.extend((0..loud).map(|k| if k % 2 == 0 { 12_000 } else { -12_000 }));
            buffer.extend(std::iter::repeat(3).take(16_000 - loud));
        }
        let original = buffer.clone();
        let first = split_segment(&mut buffer);
        // The cut lands within the last 2 s, in one of the pauses.
        assert!(first.len() >= original.len() - CUT_SEARCH);
        assert!(original[first.len()].abs() < 100);
        // More audio arrives, a second segment is taken, the rest stays.
        buffer.extend_from_slice(&loud_samples(20_000));
        let second = split_segment(&mut buffer);
        let mut joined = first.clone();
        joined.extend_from_slice(&second);
        joined.extend_from_slice(&buffer);
        let mut expected = original.clone();
        expected.extend_from_slice(&loud_samples(20_000));
        assert_eq!(joined, expected);
    }
}
