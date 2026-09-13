//! Microphone preview for the onboarding and the settings: opens the chosen
//! input and reports its level, without dictating.
//!
//! The onboarding used to ask the user to hold the dictation chord just to see
//! the meter move, which started a real dictation, cost a transcription and
//! pasted the result somewhere. This runs the recorder on its own, throws the
//! audio away and stops by itself.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::Emitter;

use crate::audio::Recorder;
use crate::model::EV_MIC_LEVEL;

static PREVIEW: Mutex<Option<Recorder>> = Mutex::new(None);
/// Bumped on every start so a level from an older preview cannot be emitted.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Open `device` ("" = system default) and emit its level until [`stop`].
/// Starting again switches the device; a running dictation always wins.
pub fn start(device: &str) -> Result<(), String> {
    if crate::pipeline::is_recording() {
        return Err("Spechy is recording a dictation right now.".into());
    }
    stop();

    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let ticks = std::sync::atomic::AtomicU64::new(0);
    let recorder = Recorder::start(device, move |level| {
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Some(app) = crate::pipeline::app_handle() {
            let _ = app.emit(EV_MIC_LEVEL, level);
        }
        // Keep no audio: drop the buffer every couple of callbacks.
        if ticks.fetch_add(1, Ordering::Relaxed) % 16 == 15 {
            if let Ok(guard) = PREVIEW.lock() {
                if let Some(preview) = guard.as_ref() {
                    preview.discard();
                }
            }
        }
    })?;

    match PREVIEW.lock() {
        Ok(mut guard) => *guard = Some(recorder),
        Err(poisoned) => *poisoned.into_inner() = Some(recorder),
    }
    Ok(())
}

/// Close the preview. Safe to call when none is running.
pub fn stop() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    let taken = match PREVIEW.lock() {
        Ok(mut guard) => guard.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    if let Some(recorder) = taken {
        let _ = recorder.stop();
    }
}

pub fn is_running() -> bool {
    match PREVIEW.lock() {
        Ok(guard) => guard.is_some(),
        Err(poisoned) => poisoned.into_inner().is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopping_an_idle_preview_is_not_an_error() {
        stop();
        assert!(!is_running());
    }
}
