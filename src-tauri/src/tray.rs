//! Tray icon and its menu. The tray is the app's real home: the main window
//! is destroyed when closed and rebuilt from here on demand.

use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::model::{DictationMode, Phase, EV_SETTINGS_CHANGED};

const ID_OPEN: &str = "open";
const ID_DICTATE: &str = "dictate";
const ID_HANDS_FREE: &str = "hands_free";
const ID_PILL: &str = "pill_always";
const ID_AUTOSTART: &str = "autostart";
const ID_QUIT: &str = "quit";

/// Build the tray icon with its menu.
pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let settings = crate::settings::current();

    let open = MenuItem::with_id(app, ID_OPEN, "Open Spechy", true, None::<&str>).map_err(err)?;
    let dictate = MenuItem::with_id(app, ID_DICTATE, "Start dictation", true, None::<&str>).map_err(err)?;
    let hands_free = CheckMenuItem::with_id(app, ID_HANDS_FREE, "Hands-free", true, false, None::<&str>).map_err(err)?;
    let pill = CheckMenuItem::with_id(app, ID_PILL, "Show pill always", true, settings.show_pill_always, None::<&str>)
        .map_err(err)?;
    let autostart = CheckMenuItem::with_id(
        app,
        ID_AUTOSTART,
        "Launch at login",
        true,
        crate::autostart::is_enabled(),
        None::<&str>,
    )
    .map_err(err)?;
    let separator = PredefinedMenuItem::separator(app).map_err(err)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "Quit", true, None::<&str>).map_err(err)?;

    let menu = Menu::with_items(
        app,
        &[&open, &dictate, &hands_free, &pill, &autostart, &separator, &quit],
    )
    .map_err(err)?;

    let mut builder = TrayIconBuilder::with_id("spechy-tray")
        .tooltip("Spechy")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app).map_err(err)?;
    Ok(())
}

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("The tray icon could not be created: {e}")
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        ID_OPEN => show_main_window(app),
        ID_DICTATE => {
            let _ = crate::pipeline::start(DictationMode::PushToTalk);
        }
        ID_HANDS_FREE => {
            if matches!(crate::pipeline::state().phase, Phase::Recording) {
                crate::pipeline::stop();
            } else {
                let _ = crate::pipeline::start(DictationMode::HandsFree);
            }
        }
        ID_PILL => {
            let mut settings = crate::settings::current();
            settings.show_pill_always = !settings.show_pill_always;
            let stored = crate::settings::set(settings);
            let _ = app.emit(EV_SETTINGS_CHANGED, &stored);
        }
        ID_AUTOSTART => {
            let mut settings = crate::settings::current();
            settings.launch_at_login = !settings.launch_at_login;
            let stored = crate::settings::set(settings);
            let _ = app.emit(EV_SETTINGS_CHANGED, &stored);
        }
        ID_QUIT => app.exit(0),
        _ => {}
    }
}

/// Show the main window, rebuilding it when it was destroyed on close.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let config = app.config().app.windows.first().cloned();
    let Some(config) = config else {
        log::error!("no window is configured in tauri.conf.json");
        return;
    };
    match tauri::WebviewWindowBuilder::from_config(app, &config) {
        Ok(builder) => match builder.build() {
            Ok(window) => {
                let _ = window.show();
                let _ = window.set_focus();
            }
            Err(e) => log::error!("the main window could not be rebuilt: {e}"),
        },
        Err(e) => log::error!("the main window could not be rebuilt: {e}"),
    }
}
