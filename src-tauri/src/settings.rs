//! Settings storage: JSON file in the app data directory, cached behind a RwLock.
//!
use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;

use crate::model::Settings;

static CACHE: RwLock<Option<Settings>> = RwLock::new(None);

/// `%APPDATA%\com.remo.spechy`, created if missing.
pub fn data_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let dir = base.join("com.remo.spechy");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

fn settings_path() -> PathBuf {
    data_dir().join("settings.json")
}

/// Load settings from disk (merged with the defaults via serde defaults) and cache them.
pub fn load() -> Settings {
    let path = settings_path();
    let settings = match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<Settings>(&raw).unwrap_or_else(|e| {
            log::warn!("settings.json is not readable ({e}), falling back to defaults");
            Settings::default()
        }),
        Err(_) => Settings::default(),
    };

    if !path.exists() {
        let _ = write_file(&settings);
    }

    if let Ok(mut cache) = CACHE.write() {
        *cache = Some(settings.clone());
    }
    settings
}

fn write_file(s: &Settings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(s).map_err(|e| format!("Could not serialize settings: {e}"))?;
    fs::write(settings_path(), json).map_err(|e| format!("Could not write settings.json: {e}"))
}

/// Persist settings to disk and refresh the cache.
pub fn save(s: &Settings) -> Result<(), String> {
    write_file(s)?;
    if let Ok(mut cache) = CACHE.write() {
        *cache = Some(s.clone());
    }
    Ok(())
}

/// The cached settings; loads from disk on first access.
pub fn current() -> Settings {
    if let Ok(cache) = CACHE.read() {
        if let Some(s) = cache.as_ref() {
            return s.clone();
        }
    }
    load()
}

/// Save new settings, apply the side effects (hotkeys, pill, autostart) and return the stored copy.
pub fn set(s: Settings) -> Settings {
    if let Err(e) = save(&s) {
        log::error!("saving settings failed: {e}");
    }
    apply_side_effects(&s);
    s
}

/// Push the settings into the subsystems that mirror them.
pub fn apply_side_effects(s: &Settings) {
    crate::hotkey::update_config(crate::hotkey::HotkeyConfig {
        push_to_talk: s.hotkeys.push_to_talk.clone(),
        hands_free: s.hotkeys.hands_free.clone(),
        command: s.hotkeys.command.clone(),
        paste_last: s.hotkeys.paste_last.clone(),
    });
    crate::pill::set_always_visible(s.show_pill_always);
    crate::pill::set_scale(s.pill_scale);
    if let Err(e) = crate::autostart::set_enabled(s.launch_at_login) {
        log::warn!("autostart could not be updated: {e}");
    }
}
