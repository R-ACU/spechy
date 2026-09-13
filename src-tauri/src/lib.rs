//! Spechy: voice dictation for Windows. Entry point of the library crate.

pub mod audio;
pub mod autostart;
pub mod commands;
pub mod db;
pub mod hardware;
pub mod hotkey;
pub mod local_models;
pub mod local_server;
pub mod model;
pub mod paste;
pub mod pill;
pub mod pipeline;
pub mod polish;
pub mod settings;
pub mod sound;
pub mod stt;
pub mod tray;
pub mod winutil;
pub mod updates;

use tauri::{Manager, WindowEvent};

pub fn run() {
    if std::env::var("RUST_LOG").is_err() {
        std::env::set_var("RUST_LOG", "info");
    }
    env_logger::init();

    let settings = settings::load();
    if let Err(e) = db::init() {
        log::error!("the database could not be opened: {e}");
    }
    let start_minimized = std::env::args().any(|a| a == "--minimized");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main_window(app);
        }))
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::suspend_hotkeys,
            commands::set_settings,
            commands::list_microphones,
            commands::test_provider,
            commands::list_models,
            commands::local_hardware,
            commands::list_local_models,
            commands::download_local_model,
            commands::remove_local_model,
            commands::open_models_dir,
            commands::local_server_status,
            commands::install_local_server,
            commands::start_local_server,
            commands::stop_local_server,
            commands::get_app_version,
            commands::check_for_updates,
            commands::download_update,
            commands::update_download_status,
            commands::install_update,
            commands::get_state,
            commands::start_dictation,
            commands::stop_dictation,
            commands::cancel_dictation,
            commands::list_history,
            commands::delete_history,
            commands::set_history_flag,
            commands::update_history_text,
            commands::repolish_history,
            commands::clear_history,
            commands::list_dictionary,
            commands::add_dictionary,
            commands::update_dictionary,
            commands::delete_dictionary,
            commands::list_snippets,
            commands::add_snippet,
            commands::update_snippet,
            commands::delete_snippet,
            commands::list_transforms,
            commands::add_transform,
            commands::update_transform,
            commands::delete_transform,
            commands::apply_transform,
            commands::get_scratchpad,
            commands::set_scratchpad,
            commands::get_stats,
            commands::export_data,
            commands::get_data_dir,
            commands::open_data_dir,
            commands::copy_to_clipboard,
            commands::open_url,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_close,
        ])
        .setup(move |app| {
            pipeline::init(app.handle().clone());
            if let Err(e) = tray::init(app.handle()) {
                log::error!("{e}");
            }
            if let Err(e) = autostart::set_enabled(settings.launch_at_login) {
                log::warn!("autostart could not be synced: {e}");
            }
            if start_minimized {
                if let Some(window) = app.get_webview_window("main") {
                    // Destroy instead of hide: a living WebView2 costs hundreds of megabytes.
                    let _ = window.destroy();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.destroy();
            }
        })
        .build(tauri::generate_context!())
        .expect("Spechy could not start")
        .run(|_app, event| {
            match event {
                // Closing the last webview must leave dictation and the tray running.
                // Explicit exits (Quit and the updater) carry a code and remain allowed.
                tauri::RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
                // Never leave the local whisper.cpp server running behind the app.
                tauri::RunEvent::Exit => {
                    crate::local_server::stop();
                }
                _ => {}
            }
        });
}
