//! Autostart via the HKCU Run key. The boot start gets "--minimized" so Spechy
//! stays silent in the tray.
#![cfg_attr(not(windows), allow(dead_code))]

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "Spechy";

#[cfg(windows)]
fn run_command() -> String {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    format!("\"{exe}\" --minimized")
}

#[cfg(windows)]
pub fn is_enabled() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(run) = hkcu.open_subkey(RUN_KEY) {
        if let Ok(value) = run.get_value::<String, _>(VALUE_NAME) {
            return !value.trim().is_empty();
        }
    }
    false
}

#[cfg(windows)]
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run, _) = hkcu.create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
    if enabled {
        run.set_value(VALUE_NAME, &run_command())
            .map_err(|e| e.to_string())
    } else {
        // Deleting a value that was never set is not an error for us.
        let _ = run.delete_value(VALUE_NAME);
        Ok(())
    }
}

#[cfg(not(windows))]
pub fn is_enabled() -> bool {
    false
}

#[cfg(not(windows))]
pub fn set_enabled(_enabled: bool) -> Result<(), String> {
    Ok(())
}
