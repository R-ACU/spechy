//! Microphone capture through cpal, normalized to 16 kHz mono 16 bit PCM.
//!
//! The cpal stream is not Send, so it lives on its own thread; the Recorder
//! handle only holds the shared buffer and a stop channel and can therefore be
//! moved between threads by the pipeline.

use std::io::Cursor;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::FromSample;

use crate::model::MicDevice;

const TARGET_RATE: u32 = 16_000;
/// One level callback per 50 ms: about 20 per second.
const LEVEL_CHUNK: usize = (TARGET_RATE as usize) / 20;

pub struct Recorder {
    buffer: Arc<Mutex<Vec<i16>>>,
    peak: Arc<AtomicU32>,
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

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Recorder {
                buffer,
                peak,
                stop: Some(stop_tx),
                handle: Some(handle),
            }),
            Ok(Err(error)) => Err(error),
            Err(_) => Err("The microphone thread stopped unexpectedly.".to_string()),
        }
    }

    /// WAV bytes of everything recorded so far. Does not stop the recording.
    pub fn snapshot_wav(&self) -> Vec<u8> {
        let samples = match self.buffer.lock() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        };
        encode_wav(&samples)
    }

    /// Stops the stream and returns the final WAV plus the duration in ms.
    pub fn stop(mut self) -> (Vec<u8>, u64) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        let samples = match self.buffer.lock() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        };
        let duration_ms = (samples.len() as u64 * 1000) / TARGET_RATE as u64;
        (encode_wav(&samples), duration_ms)
    }

    /// Highest RMS seen so far, for the silence check.
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

// ------------------------------------------------------------------ encoding

fn encode_wav(samples: &[i16]) -> Vec<u8> {
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
