//! Tauri commands. Names and argument names mirror `src/lib/ipc.ts` exactly;
//! Tauri maps the camelCase JS arguments to these snake_case parameters.

use tauri::{Emitter, Manager};

use crate::model::{
    new_id, now_ms, DictationMode, DictationState, DictionaryEntry, HardwareProfile, HistoryEntry, HistoryPage,
    LocalModelFit, MicDevice, ModelInfo, Settings, Snippet, Stats, Transform, EV_SETTINGS_CHANGED,
};

// ---------- Settings ----------

#[tauri::command]
pub fn suspend_hotkeys(suspended: bool) {
    crate::hotkey::set_suspended(suspended);
}

#[tauri::command]
pub fn get_settings() -> Settings {
    crate::settings::current()
}

#[tauri::command]
pub fn set_settings(app: tauri::AppHandle, settings: Settings) -> Result<Settings, String> {
    for (label, chord) in [
        ("Push to talk", &settings.hotkeys.push_to_talk),
        ("Hands free", &settings.hotkeys.hands_free),
        ("Command", &settings.hotkeys.command),
        ("Paste last dictation", &settings.hotkeys.paste_last),
    ] {
        crate::hotkey::parse_chord(chord)
            .map_err(|e| format!("{label} shortcut is not valid: {e}"))?;
    }
    let paste = crate::hotkey::parse_chord(&settings.hotkeys.paste_last)?;
    if !paste.iter().any(|key| !matches!(*key, 0x10 | 0x11 | 0x12 | 0x5B)) {
        return Err("Paste last dictation needs a letter, number or function key.".into());
    }
    for chord in [&settings.hotkeys.push_to_talk, &settings.hotkeys.hands_free, &settings.hotkeys.command] {
        let other = crate::hotkey::parse_chord(chord)?;
        if other.iter().all(|key| paste.contains(key)) || paste.iter().all(|key| other.contains(key)) {
            return Err("Paste last dictation must not overlap another shortcut.".into());
        }
    }
    let stored = crate::settings::set(settings)?;
    let _ = app.emit(EV_SETTINGS_CHANGED, &stored);
    Ok(stored)
}

#[tauri::command]
pub fn list_microphones() -> Vec<MicDevice> {
    crate::audio::list_devices()
}

/// `provider` is "groq", "openrouter", "custom_stt" or "custom_polish"; the custom
/// ones take their base url from the stored settings.
#[tauri::command]
pub fn test_provider(provider: String, api_key: String) -> Result<String, String> {
    crate::stt::test_key(&provider, &api_key)
}

/// Models a provider offers, for the settings model picker. Cached for 10 minutes
/// unless `refresh` is true.
#[tauri::command]
pub fn list_models(provider: String, refresh: bool) -> Result<Vec<ModelInfo>, String> {
    crate::stt::list_models(&provider, refresh)
}

// ---------- Local model library ----------

/// RAM, CPU and GPU of this machine, used to score local models.
#[tauri::command]
pub fn local_hardware() -> HardwareProfile {
    crate::local_models::hardware()
}

/// The curated local model catalogue, scored for this PC, best pick first.
#[tauri::command]
pub fn list_local_models() -> Vec<LocalModelFit> {
    crate::local_models::library()
}

/// Download a curated model into the models folder. Progress is streamed to the UI.
#[tauri::command]
pub async fn download_local_model(
    id: String,
    on_progress: tauri::ipc::Channel<crate::local_models::Progress>,
) -> Result<LocalModelFit, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::local_models::download(&id, |value| {
            let _ = on_progress.send(value);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete a downloaded model and return the refreshed catalogue.
#[tauri::command]
pub fn remove_local_model(id: String) -> Result<Vec<LocalModelFit>, String> {
    crate::local_models::remove(&id)
}

/// Open the folder downloaded models live in, for use with a local server.
#[tauri::command]
pub fn open_models_dir() -> Result<(), String> {
    let dir = crate::local_models::models_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create the models folder: {e}"))?;
    std::process::Command::new("explorer")
        .arg(dir.as_os_str())
        .spawn()
        .map_err(|e| format!("Could not open the folder: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<crate::updates::UpdateInfo, String> {
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || crate::updates::check(&version))
        .await.map_err(|error| error.to_string())?
}

// ---------- Dictation ----------

#[tauri::command]
pub fn update_download_status() -> Result<crate::updates::DownloadStatus, String> {
    crate::updates::status()
}

#[tauri::command]
pub async fn download_update(app: tauri::AppHandle, on_progress: tauri::ipc::Channel<crate::updates::Progress>) -> Result<String, String> {
    let version = app.package_info().version.to_string();
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || crate::updates::download(&version, &cache, |value| { let _ = on_progress.send(value); }))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    if crate::pipeline::state().phase != crate::model::Phase::Idle {
        return Err("Finish your current dictation before installing the update.".into());
    }
    tauri::async_runtime::spawn_blocking(crate::updates::install).await.map_err(|e| e.to_string())??;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn get_state() -> DictationState {
    crate::pipeline::state()
}

#[tauri::command]
pub fn start_dictation(mode: DictationMode) -> Result<(), String> {
    crate::pipeline::start(mode)
}

#[tauri::command]
pub fn stop_dictation() {
    crate::pipeline::stop();
}

#[tauri::command]
pub fn cancel_dictation() {
    crate::pipeline::cancel();
}

// ---------- History ----------

#[tauri::command]
pub fn list_history(limit: i64, offset: i64, query: String) -> Result<HistoryPage, String> {
    crate::db::list_history(limit, offset, &query)
}

#[tauri::command]
pub fn delete_history(id: String) -> Result<(), String> {
    crate::db::delete_history(&id)
}

#[tauri::command]
pub fn set_history_flag(id: String, flagged: bool) -> Result<(), String> {
    crate::db::set_history_flag(&id, flagged)
}

#[tauri::command]
pub fn update_history_text(id: String, text: String) -> Result<(), String> {
    crate::db::update_history_text(&id, &text)
}

/// Run the polish step over a stored dictation again and save the result.
#[tauri::command]
pub fn repolish_history(id: String) -> Result<HistoryEntry, String> {
    let entry = crate::db::get_history(&id)?;
    let settings = crate::settings::current();
    let dictionary = crate::db::list_dictionary()?;
    let snippets = crate::db::list_snippets()?;
    let app = crate::winutil::ForegroundApp {
        process_name: entry.app_name.clone(),
        title: entry.app_title.clone(),
        hwnd: 0,
    };
    let result = crate::polish::polish(crate::polish::PolishContext {
        raw: &entry.raw_text,
        settings: &settings,
        dictionary: &dictionary,
        snippets: &snippets,
        app: &app,
        vibe: false,
        command_instruction: None,
        selection: None,
    })?;
    crate::db::update_history_text(&id, &result.text)?;
    crate::db::get_history(&id)
}

#[tauri::command]
pub fn clear_history() -> Result<(), String> {
    crate::db::clear_history()
}

// ---------- Dictionary ----------

#[tauri::command]
pub fn list_dictionary() -> Result<Vec<DictionaryEntry>, String> {
    crate::db::list_dictionary()
}

#[tauri::command]
pub fn add_dictionary(word: String, misspelling: String) -> Result<DictionaryEntry, String> {
    if word.trim().is_empty() {
        return Err("The word must not be empty".into());
    }
    let entry = DictionaryEntry {
        id: new_id(),
        word: word.trim().to_string(),
        misspelling: misspelling.trim().to_string(),
        auto_learned: false,
        starred: false,
        created_at: now_ms(),
        uses: 0,
    };
    crate::db::upsert_dictionary(&entry)?;
    Ok(entry)
}

#[tauri::command]
pub fn update_dictionary(entry: DictionaryEntry) -> Result<DictionaryEntry, String> {
    crate::db::upsert_dictionary(&entry)?;
    Ok(entry)
}

#[tauri::command]
pub fn delete_dictionary(id: String) -> Result<(), String> {
    crate::db::delete_dictionary(&id)
}

// ---------- Snippets ----------

#[tauri::command]
pub fn list_snippets() -> Result<Vec<Snippet>, String> {
    crate::db::list_snippets()
}

#[tauri::command]
pub fn add_snippet(trigger: String, text: String) -> Result<Snippet, String> {
    if trigger.trim().is_empty() {
        return Err("The trigger must not be empty".into());
    }
    let snippet = Snippet {
        id: new_id(),
        trigger: trigger.trim().to_string(),
        text,
        created_at: now_ms(),
        uses: 0,
    };
    crate::db::upsert_snippet(&snippet)?;
    Ok(snippet)
}

#[tauri::command]
pub fn update_snippet(snippet: Snippet) -> Result<Snippet, String> {
    crate::db::upsert_snippet(&snippet)?;
    Ok(snippet)
}

#[tauri::command]
pub fn delete_snippet(id: String) -> Result<(), String> {
    crate::db::delete_snippet(&id)
}

// ---------- Transforms ----------

#[tauri::command]
pub fn list_transforms() -> Result<Vec<Transform>, String> {
    crate::db::list_transforms()
}

#[tauri::command]
pub fn add_transform(name: String, prompt: String) -> Result<Transform, String> {
    if name.trim().is_empty() {
        return Err("The name must not be empty".into());
    }
    if prompt.trim().is_empty() {
        return Err("The prompt must not be empty".into());
    }
    let transform = Transform {
        id: new_id(),
        name: name.trim().to_string(),
        prompt,
        builtin: false,
        created_at: now_ms(),
    };
    crate::db::upsert_transform(&transform)?;
    Ok(transform)
}

#[tauri::command]
pub fn update_transform(transform: Transform) -> Result<Transform, String> {
    if transform.name.trim().is_empty() || transform.prompt.trim().is_empty() {
        return Err("The name and prompt must not be empty".into());
    }
    crate::db::upsert_transform(&transform)?;
    Ok(transform)
}

#[tauri::command]
pub fn delete_transform(id: String) -> Result<(), String> {
    crate::db::delete_transform(&id)
}

#[tauri::command]
pub fn apply_transform(transform_id: String, text: String) -> Result<String, String> {
    let transform = crate::db::get_transform(&transform_id)?;
    crate::polish::apply_transform(&transform.prompt, &text, &crate::settings::current())
}

// ---------- Scratchpad ----------

#[tauri::command]
pub fn get_scratchpad() -> Result<String, String> {
    crate::db::get_scratchpad()
}

#[tauri::command]
pub fn set_scratchpad(text: String) -> Result<(), String> {
    crate::db::set_scratchpad(&text)
}

// ---------- Stats and data ----------

#[tauri::command]
pub fn get_stats() -> Result<Stats, String> {
    crate::db::stats()
}

/// Write the full export next to the database and return the file path.
#[tauri::command]
pub fn export_data() -> Result<String, String> {
    let json = crate::db::export_json()?;
    let name = format!("spechy-export-{}.json", chrono::Local::now().format("%Y-%m-%d"));
    let path = crate::settings::data_dir().join(name);
    std::fs::write(&path, json).map_err(|e| format!("Could not write the export: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_data_dir() -> String {
    crate::settings::data_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub fn open_data_dir() -> Result<(), String> {
    let dir = crate::settings::data_dir();
    std::process::Command::new("explorer")
        .arg(dir.as_os_str())
        .spawn()
        .map_err(|e| format!("Could not open the folder: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn copy_to_clipboard(text: String) -> Result<(), String> {
    crate::paste::set_clipboard(&text)
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")) {
        return Err("Only web links can be opened".into());
    }
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe { ShellExecuteW(None, windows::core::w!("open"), PCWSTR(wide.as_ptr()), None, None, SW_SHOWNORMAL) };
    if result.0 as isize <= 32 { return Err("Could not open the link.".into()); }
    Ok(())
}

// ---------- Window ----------

#[tauri::command]
pub fn window_minimize(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.minimize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn window_toggle_maximize(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let maximized = w.is_maximized().map_err(|e| e.to_string())?;
        if maximized {
            w.unmaximize().map_err(|e| e.to_string())?;
        } else {
            w.maximize().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Destroy the webview so its memory is released; the app stays alive in the tray.
#[tauri::command]
pub fn window_close(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}
