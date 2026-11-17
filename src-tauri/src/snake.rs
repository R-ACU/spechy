use std::process::Child;
use std::sync::Mutex;

static LISTENER: Mutex<Option<(String, Child)>> = Mutex::new(None);

#[tauri::command]
pub fn snake_stop(session: String) {
    let mut slot = LISTENER.lock().unwrap();
    if slot.as_ref().is_some_and(|(id, _)| id == &session) {
        if let Some((_, mut child)) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tauri::command]
pub fn snake_start(window: tauri::Window, session: String) -> Result<(), String> {
    #[cfg(not(windows))]
    { let _ = (window, session); Err("Sprachsteuerung benötigt Windows.".into()) }
    #[cfg(windows)]
    {
        use std::{io::{BufRead, BufReader}, os::windows::process::CommandExt, process::{Command, Stdio}};
        use tauri::Emitter;
        let mut slot = LISTENER.lock().unwrap();
        if let Some((_, mut old)) = slot.take() { let _ = old.kill(); let _ = old.wait(); }
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", include_str!("snake.ps1")])
            .env("SPECHY_PARENT", std::process::id().to_string())
            .creation_flags(0x08000000).stdout(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
        let output = child.stdout.take().unwrap();
        *slot = Some((session.clone(), child));
        std::thread::spawn(move || {
            for word in BufReader::new(output).lines().map_while(Result::ok) {
                let _ = window.emit("snake-input", (&session, word));
            }
            let _ = window.emit("snake-input", (&session, "closed"));
            snake_stop(session);
        });
        Ok(())
    }
}
