//! Feedback sounds.
//!
//! Feedback uses the supplied Wispr Flow default-theme WAVs.
//!
//! A Start and a Stop sound can land within a few hundred milliseconds of each
//! other. Opening a second waveOut device while the first one is still playing
//! fails on some drivers (MMSYSERR_ALLOCATED) and the tone is silently lost, so
//! everything goes through one shared device on a single worker thread: sounds
//! are queued and played one after another. The device is opened with the first
//! sound and closed again after a couple of seconds of silence.
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SoundKind {
    Start,
    Stop,
    Error,
}

const FALLBACK_RATE: u32 = 44100;

/// One decoded sound: raw PCM plus the format it has to be played in.
struct Pcm {
    channels: u16,
    sample_rate: u32,
    bits: u16,
    data: Vec<u8>,
}

/// Format identity of the open device, so a differing sound reopens it.
type Format = (u16, u32, u16);

impl Pcm {
    fn format(&self) -> Format {
        (self.channels, self.sample_rate, self.bits)
    }
}

fn pcm_for(kind: SoundKind) -> Pcm {
    let bytes: &[u8] = match kind {
        SoundKind::Start => include_bytes!("../sounds/start.wav"),
        SoundKind::Stop => include_bytes!("../sounds/stop.wav"),
        SoundKind::Error => include_bytes!("../sounds/error.wav"),
    };
    decode_wav(bytes).unwrap_or_else(|| synthesize(kind))
}

fn decode_wav(bytes: &[u8]) -> Option<Pcm> {
    let mut reader = hound::WavReader::new(std::io::Cursor::new(bytes)).ok()?;
    let spec = reader.spec();
    if spec.bits_per_sample != 16 || spec.sample_format != hound::SampleFormat::Int { return None; }
    let samples = reader.samples::<i16>().collect::<Result<Vec<_>, _>>().ok()?;
    Some(Pcm {
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        bits: spec.bits_per_sample,
        data: samples.iter().flat_map(|sample| sample.to_le_bytes()).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supplied_sounds_decode_at_their_original_format() {
        for (kind, rate, frames) in [(SoundKind::Start, 44100, 7952), (SoundKind::Stop, 44100, 9663), (SoundKind::Error, 48000, 22463)] {
            let pcm = pcm_for(kind);
            assert_eq!(pcm.channels, 2);
            assert_eq!(pcm.sample_rate, rate);
            assert_eq!(pcm.data.len(), frames * 4);
        }
    }
}

fn synthesize(kind: SoundKind) -> Pcm {
    let notes: &[(f32, f32, f32)] = match kind {
        // (frequency Hz, duration seconds, amplitude)
        SoundKind::Start => &[(587.33, 0.08, 0.30), (880.00, 0.08, 0.30)],
        SoundKind::Stop => &[(880.00, 0.08, 0.28), (587.33, 0.08, 0.28)],
        SoundKind::Error => &[(180.0, 0.10, 0.32), (150.0, 0.16, 0.32)],
    };

    let mut samples: Vec<i16> = Vec::new();
    for (freq, seconds, amplitude) in notes.iter().copied() {
        let count = (FALLBACK_RATE as f32 * seconds) as usize;
        let attack = (FALLBACK_RATE as f32 * 0.006) as usize;
        let release = (FALLBACK_RATE as f32 * 0.020) as usize;
        for i in 0..count {
            let t = i as f32 / FALLBACK_RATE as f32;
            let mut value = (2.0 * std::f32::consts::PI * freq * t).sin();
            if kind == SoundKind::Error {
                // A little second harmonic gives the buzz some body.
                value = 0.75 * value + 0.25 * (2.0 * std::f32::consts::PI * freq * 2.0 * t).sin();
            }
            // Attack and release ramps avoid the click at the buffer edges.
            let mut envelope = 1.0f32;
            if i < attack {
                envelope = i as f32 / attack as f32;
            }
            if i + release > count {
                envelope = envelope.min((count - i) as f32 / release as f32);
            }
            let sample = value * amplitude * envelope;
            samples.push((sample.clamp(-1.0, 1.0) * 32000.0) as i16);
        }
    }
    // Short tail of silence so the device does not cut the release off.
    samples.extend(std::iter::repeat(0i16).take(FALLBACK_RATE as usize / 50));

    Pcm {
        channels: 1,
        sample_rate: FALLBACK_RATE,
        bits: 16,
        data: samples.iter().flat_map(|s| s.to_le_bytes()).collect(),
    }
}

// ------------------------------------------------------------------ queue

fn queue() -> &'static Mutex<VecDeque<SoundKind>> {
    static QUEUE: OnceLock<Mutex<VecDeque<SoundKind>>> = OnceLock::new();
    QUEUE.get_or_init(|| Mutex::new(VecDeque::new()))
}

static WORKER: OnceLock<std::thread::Thread> = OnceLock::new();
static WORKER_STARTED: AtomicBool = AtomicBool::new(false);
/// How long the shared device stays open after the last sound.
const IDLE_CLOSE_MS: u64 = 2000;

fn pop() -> Option<SoundKind> {
    queue().lock().ok().and_then(|mut q| q.pop_front())
}

fn queue_is_empty() -> bool {
    queue().lock().map(|q| q.is_empty()).unwrap_or(true)
}

#[cfg(windows)]
pub fn play(kind: SoundKind) {
    start_worker();
    if let Ok(mut guard) = queue().lock() {
        // A backlog would only ever arrive late; drop the oldest instead.
        if guard.len() >= 4 {
            guard.pop_front();
        }
        guard.push_back(kind);
    }
    if let Some(worker) = WORKER.get() {
        worker.unpark();
    }
}

#[cfg(not(windows))]
pub fn play(_kind: SoundKind) {}

#[cfg(windows)]
fn start_worker() {
    if WORKER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = std::thread::spawn(worker_loop);
    let _ = WORKER.set(handle.thread().clone());
}

#[cfg(windows)]
fn worker_loop() {
    use std::time::Duration;
    use windows::Win32::Media::Audio::{waveOutClose, HWAVEOUT};

    let mut device: Option<(HWAVEOUT, Format)> = None;
    loop {
        while let Some(kind) = pop() {
            let pcm = pcm_for(kind);
            let format = pcm.format();

            // A sound in a different format needs its own device.
            if let Some((handle, open_format)) = device {
                if open_format != format {
                    unsafe {
                        let _ = waveOutClose(handle);
                    }
                    device = None;
                }
            }
            if device.is_none() {
                device = open_device(format).map(|handle| (handle, format));
            }

            match device {
                Some((handle, _)) => {
                    if let Err(error) = write_blocking(handle, &pcm.data) {
                        log::debug!("sound: {error}");
                        // The device went away; drop it and open a fresh one next time.
                        unsafe {
                            let _ = waveOutClose(handle);
                        }
                        device = None;
                    }
                }
                None => log::debug!("sound: no output device available"),
            }
        }

        if device.is_some() {
            std::thread::park_timeout(Duration::from_millis(IDLE_CLOSE_MS));
            if queue_is_empty() {
                if let Some((handle, _)) = device.take() {
                    unsafe {
                        let _ = waveOutClose(handle);
                    }
                }
            }
        } else {
            std::thread::park();
        }
    }
}

#[cfg(windows)]
fn open_device(format: Format) -> Option<windows::Win32::Media::Audio::HWAVEOUT> {
    use std::time::Duration;
    use windows::Win32::Media::Audio::{
        waveOutOpen, HWAVEOUT, MIDI_WAVE_OPEN_TYPE, WAVEFORMATEX, WAVE_FORMAT_PCM, WAVE_MAPPER,
    };
    use windows::Win32::Media::MMSYSERR_NOERROR;

    let (channels, sample_rate, bits) = format;
    let block_align = channels * bits / 8;
    let wave_format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: channels,
        nSamplesPerSec: sample_rate,
        nAvgBytesPerSec: sample_rate * block_align as u32,
        nBlockAlign: block_align,
        wBitsPerSample: bits,
        cbSize: 0,
    };

    // Another process can hold the mapper for a moment; a couple of retries is
    // enough in practice.
    for attempt in 0..3 {
        let mut device = HWAVEOUT::default();
        let result = unsafe {
            waveOutOpen(
                Some(&mut device),
                WAVE_MAPPER,
                &wave_format,
                0,
                0,
                MIDI_WAVE_OPEN_TYPE(0),
            )
        };
        if result == MMSYSERR_NOERROR {
            return Some(device);
        }
        log::debug!("sound: waveOutOpen failed ({result}), attempt {attempt}");
        std::thread::sleep(Duration::from_millis(40));
    }
    None
}

/// Writes one buffer and waits until the device is done with it.
#[cfg(windows)]
fn write_blocking(
    device: windows::Win32::Media::Audio::HWAVEOUT,
    bytes: &[u8],
) -> Result<(), String> {
    use std::time::{Duration, Instant};
    use windows::Win32::Media::Audio::{
        waveOutPrepareHeader, waveOutUnprepareHeader, waveOutWrite, WAVEHDR,
    };
    use windows::Win32::Media::MMSYSERR_NOERROR;

    /// WHDR_DONE
    const DONE: u32 = 0x0000_0001;

    if bytes.is_empty() {
        return Ok(());
    }
    let header_size = std::mem::size_of::<WAVEHDR>() as u32;

    unsafe {
        let mut header = WAVEHDR {
            lpData: windows::core::PSTR(bytes.as_ptr() as *mut u8),
            dwBufferLength: bytes.len() as u32,
            ..Default::default()
        };

        let result = waveOutPrepareHeader(device, &mut header, header_size);
        if result != MMSYSERR_NOERROR {
            return Err(format!("waveOutPrepareHeader failed ({result})"));
        }

        let result = waveOutWrite(device, &mut header, header_size);
        if result != MMSYSERR_NOERROR {
            let _ = waveOutUnprepareHeader(device, &mut header, header_size);
            return Err(format!("waveOutWrite failed ({result})"));
        }

        // Poll for WHDR_DONE instead of installing a callback.
        let deadline = Instant::now() + Duration::from_secs(5);
        while header.dwFlags & DONE == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }

        let _ = waveOutUnprepareHeader(device, &mut header, header_size);
    }

    Ok(())
}
