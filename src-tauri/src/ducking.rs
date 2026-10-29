//! "Mute music while dictating": other apps go silent while the microphone records.
//!
//! Every audio session on every active output device is muted, except Spechy's
//! own (the start and stop sounds stay audible), the Windows system sounds and
//! sessions the user had muted already. Exactly the sessions muted here are
//! unmuted again when the recording ends. Sessions keep their mute flag even if
//! Spechy dies, so the process ids are also written to `muted-apps.txt` and the
//! next start unmutes them.
//!
//! COM lives on one worker thread; callers only send it messages, so the hotkey
//! worker and the pipeline never wait for the audio stack.
#![cfg_attr(not(windows), allow(dead_code))]

use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

enum Msg {
    Mute,
    /// The optional sender is told when the sessions are back (used on exit).
    Restore(Option<Sender<()>>),
}

static WORKER: OnceLock<Mutex<Sender<Msg>>> = OnceLock::new();

fn marker_path() -> PathBuf {
    crate::settings::data_dir().join("muted-apps.txt")
}

fn send(msg: Msg) {
    let tx = WORKER.get_or_init(|| {
        let (tx, rx) = channel();
        std::thread::spawn(move || worker(rx));
        Mutex::new(tx)
    });
    if let Ok(tx) = tx.lock() {
        let _ = tx.send(msg);
    }
}

/// Start the worker and unmute whatever a crashed run left muted.
pub fn init() {
    if marker_path().exists() {
        send(Msg::Restore(None));
    }
}

/// Mute the other apps, if the setting is on. A second call while muted does nothing.
pub fn mute() {
    if crate::settings::current().mute_while_dictating {
        send(Msg::Mute);
    }
}

/// Bring back what `mute` silenced. Cheap when nothing is muted.
pub fn restore() {
    send(Msg::Restore(None));
}

/// Like `restore`, but waits (at most a second) so the sessions are back before the process ends.
pub fn restore_blocking() {
    if WORKER.get().is_none() {
        return;
    }
    let (tx, rx) = channel();
    send(Msg::Restore(Some(tx)));
    let _ = rx.recv_timeout(Duration::from_secs(1));
}

#[cfg(windows)]
fn worker(rx: std::sync::mpsc::Receiver<Msg>) {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let mut held: Vec<win::Held> = Vec::new();
    for msg in rx {
        match msg {
            Msg::Mute => {
                if !held.is_empty() {
                    continue;
                }
                match win::mute_others() {
                    Ok(muted) => {
                        if !muted.is_empty() {
                            let pids: Vec<String> = muted.iter().map(|h| h.pid.to_string()).collect();
                            let _ = std::fs::write(marker_path(), pids.join("\n"));
                            log::info!("muted {} audio session(s) while dictating", muted.len());
                        }
                        held = muted;
                    }
                    Err(e) => log::warn!("other apps could not be muted: {e}"),
                }
            }
            Msg::Restore(done) => {
                if !held.is_empty() {
                    win::unmute(&held);
                    held.clear();
                    let _ = std::fs::remove_file(marker_path());
                } else if let Ok(text) = std::fs::read_to_string(marker_path()) {
                    // Left over from a run that ended while muted.
                    let pids: Vec<u32> = text.lines().filter_map(|l| l.trim().parse().ok()).collect();
                    match win::unmute_pids(&pids) {
                        Ok(n) => log::info!("unmuted {n} audio session(s) left muted by an earlier run"),
                        Err(e) => log::warn!("muted sessions from an earlier run could not be restored: {e}"),
                    }
                    let _ = std::fs::remove_file(marker_path());
                }
                if let Some(done) = done {
                    let _ = done.send(());
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn worker(rx: std::sync::mpsc::Receiver<Msg>) {
    for msg in rx {
        if let Msg::Restore(Some(done)) = msg {
            let _ = done.send(());
        }
    }
}

#[cfg(windows)]
mod win {
    use windows::core::{Interface, Result};
    use windows::Win32::Media::Audio::{
        eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume,
        MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::Foundation::S_OK;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    pub struct Held {
        pub pid: u32,
        volume: ISimpleAudioVolume,
    }

    /// Every session on every active output device, with its process id.
    fn sessions() -> Result<Vec<(u32, ISimpleAudioVolume)>> {
        let own = std::process::id();
        let mut out = Vec::new();
        unsafe {
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
            for d in 0..devices.GetCount()? {
                let Ok(device) = devices.Item(d) else { continue };
                let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
                let Ok(list) = manager.GetSessionEnumerator() else { continue };
                for i in 0..list.GetCount().unwrap_or(0) {
                    let Ok(control) = list.GetSession(i) else { continue };
                    let Ok(control2) = control.cast::<IAudioSessionControl2>() else { continue };
                    if control2.IsSystemSoundsSession() == S_OK {
                        continue;
                    }
                    let Ok(pid) = control2.GetProcessId() else { continue };
                    if pid == own || pid == 0 {
                        continue;
                    }
                    if let Ok(volume) = control.cast::<ISimpleAudioVolume>() {
                        out.push((pid, volume));
                    }
                }
            }
        }
        Ok(out)
    }

    /// Mute every session that is audible now and hand back exactly those.
    pub fn mute_others() -> Result<Vec<Held>> {
        let mut held = Vec::new();
        for (pid, volume) in sessions()? {
            unsafe {
                if volume.GetMute().map(|m| m.as_bool()).unwrap_or(true) {
                    continue; // muted by the user, not ours to touch
                }
                if volume.SetMute(true, std::ptr::null()).is_ok() {
                    held.push(Held { pid, volume });
                }
            }
        }
        Ok(held)
    }

    #[cfg(test)]
    pub fn is_muted(h: &Held) -> bool {
        unsafe { h.volume.GetMute().map(|m| m.as_bool()).unwrap_or(false) }
    }

    pub fn unmute(held: &[Held]) {
        for h in held {
            unsafe {
                let _ = h.volume.SetMute(false, std::ptr::null());
            }
        }
    }

    /// Unmute the sessions of these processes (recovery after a crash).
    pub fn unmute_pids(pids: &[u32]) -> Result<usize> {
        let mut n = 0;
        for (pid, volume) in sessions()? {
            if pids.contains(&pid) {
                unsafe {
                    if volume.GetMute().map(|m| m.as_bool()).unwrap_or(false)
                        && volume.SetMute(false, std::ptr::null()).is_ok()
                    {
                        n += 1;
                    }
                }
            }
        }
        Ok(n)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::win;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    /// Touches the real mixer of this machine (no sound): run with
    /// `cargo test --lib ducking -- --ignored --test-threads=1`.
    #[test]
    #[ignore]
    fn mutes_other_apps_and_restores_exactly_those() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let held = win::mute_others().expect("sessions");
        println!("muted {} session(s): {:?}", held.len(), held.iter().map(|h| h.pid).collect::<Vec<_>>());
        assert!(held.iter().all(|h| h.pid != std::process::id()));
        assert!(held.iter().all(|h| win::is_muted(h)));
        // A second pass finds nothing new to mute: everything audible is ours now.
        assert!(win::mute_others().expect("sessions").is_empty());
        win::unmute(&held);
        assert!(held.iter().all(|h| !win::is_muted(h)));

        // Crash recovery: muted again, then only the process ids are known.
        let held = win::mute_others().expect("sessions");
        let pids: Vec<u32> = held.iter().map(|h| h.pid).collect();
        let restored = win::unmute_pids(&pids).expect("sessions");
        assert_eq!(restored, held.len());
        assert!(held.iter().all(|h| !win::is_muted(h)));
    }
}
