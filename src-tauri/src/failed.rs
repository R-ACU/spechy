//! Failed dictations: when the transcription does not come back, the recording
//! stays on disk until the user retries or discards it, so nothing spoken is lost.
//!
//! These are the only recordings a release build ever writes. They are deleted
//! when a retry succeeds, on discard, and after `RETENTION_MS`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::model::{now_ms, FailedDictation, EV_FAILED_CHANGED};

/// Older failures are pruned so the folder cannot grow without bound.
const MAX_KEPT: usize = 10;
const RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// One piece of a dictation in spoken order: already transcribed text or audio
/// that still has to go through the transcriber (hands-free has several).
#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    Text(String),
    Audio(Vec<u8>),
}

/// Everything a retry needs besides the audio, stored next to the WAV files.
#[derive(Debug, Clone, PartialEq)]
pub struct Pending {
    pub info: FailedDictation,
    /// Window the dictation was meant for; a retry from the pill pastes there.
    pub target_hwnd: isize,
    /// Selection of a command dictation.
    pub selection: String,
    pub parts: Vec<Part>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum StoredPart {
    Text(String),
    /// File name of a WAV inside the failed folder.
    Audio(String),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    info: FailedDictation,
    target_hwnd: isize,
    selection: String,
    parts: Vec<StoredPart>,
}

fn dir() -> PathBuf {
    crate::settings::data_dir().join("failed")
}

fn record_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

/// Ids are uuids; anything else could escape the folder.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn read_record(dir: &Path, id: &str) -> Result<Record, String> {
    if !valid_id(id) {
        return Err("This dictation does not exist.".into());
    }
    let json = std::fs::read_to_string(record_path(dir, id))
        .map_err(|_| "This dictation is no longer available.".to_string())?;
    serde_json::from_str(&json).map_err(|e| format!("The saved dictation is damaged: {e}"))
}

fn remove_in(dir: &Path, id: &str) {
    if !valid_id(id) {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        let prefix = format!("{id}-");
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) && name.ends_with(".wav") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let _ = std::fs::remove_file(record_path(dir, id));
}

fn save_in(dir: &Path, pending: &Pending) -> Result<(), String> {
    let id = &pending.info.id;
    if !valid_id(id) {
        return Err("Invalid dictation id.".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not keep the recording: {e}"))?;
    // A retry that got further replaces the earlier files of the same dictation.
    remove_in(dir, id);

    let mut parts = Vec::with_capacity(pending.parts.len());
    for (index, part) in pending.parts.iter().enumerate() {
        match part {
            Part::Text(text) => parts.push(StoredPart::Text(text.clone())),
            Part::Audio(wav) => {
                let name = format!("{id}-{index}.wav");
                std::fs::write(dir.join(&name), wav).map_err(|e| format!("Could not keep the recording: {e}"))?;
                parts.push(StoredPart::Audio(name));
            }
        }
    }
    let record = Record {
        info: pending.info.clone(),
        target_hwnd: pending.target_hwnd,
        selection: pending.selection.clone(),
        parts,
    };
    let json = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    std::fs::write(record_path(dir, id), json).map_err(|e| format!("Could not keep the recording: {e}"))
}

fn load_in(dir: &Path, id: &str) -> Result<Pending, String> {
    let record = read_record(dir, id)?;
    let mut parts = Vec::with_capacity(record.parts.len());
    for part in record.parts {
        match part {
            StoredPart::Text(text) => parts.push(Part::Text(text)),
            StoredPart::Audio(name) => {
                if name.contains(['/', '\\']) || name.contains("..") {
                    return Err("The saved dictation is damaged.".into());
                }
                let wav = std::fs::read(dir.join(&name))
                    .map_err(|_| "The recording of this dictation is missing.".to_string())?;
                parts.push(Part::Audio(wav));
            }
        }
    }
    Ok(Pending { info: record.info, target_hwnd: record.target_hwnd, selection: record.selection, parts })
}

/// Newest first. Expired and surplus entries are deleted on the way.
fn list_in(dir: &Path, now: i64) -> Vec<FailedDictation> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut infos: Vec<FailedDictation> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let id = name.strip_suffix(".json")?.to_string();
            match read_record(dir, &id) {
                Ok(record) => Some(record.info),
                Err(_) => {
                    remove_in(dir, &id);
                    None
                }
            }
        })
        .collect();
    infos.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    let mut kept = Vec::with_capacity(infos.len().min(MAX_KEPT));
    for info in infos {
        if kept.len() >= MAX_KEPT || now - info.created_at > RETENTION_MS {
            remove_in(dir, &info.id);
        } else {
            kept.push(info);
        }
    }
    kept
}

fn emit_changed() {
    let list = list();
    if let Some(app) = crate::pipeline::app_handle() {
        let _ = app.emit(EV_FAILED_CHANGED, &list);
    }
}

// ---------- Public API ----------

pub fn save(pending: &Pending) -> Result<(), String> {
    let result = save_in(&dir(), pending);
    emit_changed();
    result
}

pub fn load(id: &str) -> Result<Pending, String> {
    load_in(&dir(), id)
}

pub fn list() -> Vec<FailedDictation> {
    list_in(&dir(), now_ms())
}

pub fn discard(id: &str) {
    remove_in(&dir(), id);
    emit_changed();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DictationMode;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("spechy-failed-{name}-{}", crate::model::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn pending(id: &str, created_at: i64) -> Pending {
        Pending {
            info: FailedDictation {
                id: id.into(),
                created_at,
                mode: DictationMode::HandsFree,
                app_name: "code.exe".into(),
                app_title: "main.rs".into(),
                duration_ms: 65_000,
                error: "Groq: request timed out".into(),
            },
            target_hwnd: 42,
            selection: String::new(),
            parts: vec![Part::Text("first minute".into()), Part::Audio(vec![1, 2, 3]), Part::Audio(vec![4, 5])],
        }
    }

    #[test]
    fn a_saved_dictation_comes_back_in_spoken_order() {
        let dir = temp_dir("roundtrip");
        let saved = pending("0a1b-2c", 1_000);
        save_in(&dir, &saved).unwrap();
        assert_eq!(load_in(&dir, "0a1b-2c").unwrap(), saved);
        assert_eq!(list_in(&dir, 2_000).len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn saving_again_replaces_the_old_audio_and_discard_removes_everything() {
        let dir = temp_dir("replace");
        save_in(&dir, &pending("abc", 1_000)).unwrap();
        let mut progressed = pending("abc", 1_000);
        progressed.parts = vec![Part::Text("first minute".into()), Part::Text("second".into()), Part::Audio(vec![4, 5])];
        save_in(&dir, &progressed).unwrap();
        assert_eq!(load_in(&dir, "abc").unwrap().parts, progressed.parts);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2, "one json and one wav");

        remove_in(&dir, "abc");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn old_and_surplus_recordings_are_pruned() {
        let dir = temp_dir("prune");
        let now = RETENTION_MS * 2;
        save_in(&dir, &pending("dead", now - RETENTION_MS - 1)).unwrap();
        for index in 0..(MAX_KEPT + 2) {
            save_in(&dir, &pending(&format!("{index:x}0"), now - index as i64)).unwrap();
        }
        let kept = list_in(&dir, now);
        assert_eq!(kept.len(), MAX_KEPT);
        assert_eq!(kept[0].id, "00", "newest first");
        assert!(load_in(&dir, "dead").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ids_cannot_leave_the_folder() {
        let dir = temp_dir("ids");
        assert!(load_in(&dir, "..\\settings").is_err());
        assert!(save_in(&dir, &pending("../x", 1)).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
