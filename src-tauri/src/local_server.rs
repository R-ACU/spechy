//! The local whisper.cpp server: download a pinned build, unpack it into the app
//! data folder, start it for a downloaded model and stop it again.
//!
//! whisper.cpp has no OpenAI-compatible endpoints, so this pairs with
//! `custom_stt_api = "whisper_cpp"` and the `/inference` path in `stt.rs`.
//! Nothing here runs in the background: the server only starts when the user
//! asks for it, and it is killed when Spechy exits.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::model::{HardwareProfile, LocalServerStatus};
use crate::local_models::Progress;

/// Pinned whisper.cpp build. Bump together with the checksums below.
pub const BUILD: &str = "b5130";

struct Flavor {
    id: &'static str,
    label: &'static str,
    asset: &'static str,
    size_bytes: u64,
    sha256: &'static str,
}

/// The CPU build runs everywhere; the CUDA build needs an NVIDIA card and is
/// roughly twenty times faster on one, so it is the default there.
const FLAVORS: &[Flavor] = &[
    Flavor {
        id: "cpu",
        label: "CPU",
        asset: "whisper-bin-x64.zip",
        size_bytes: 8_573_270,
        sha256: "f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c",
    },
    Flavor {
        id: "cuda",
        label: "CUDA (NVIDIA)",
        asset: "whisper-cublas-12.4.0-bin-x64.zip",
        size_bytes: 674_539_285,
        sha256: "af520ddd034d985b55dfeea3e465ed93653ba2aee1a55e865033edc548c272a7",
    },
];

struct Running {
    child: Child,
    flavor: String,
    port: u16,
    model_id: String,
    model_path: String,
}

static SERVER: Mutex<Option<Running>> = Mutex::new(None);
static INSTALL: Mutex<()> = Mutex::new(());

fn flavor(id: &str) -> Option<&'static Flavor> {
    FLAVORS.iter().find(|flavor| flavor.id == id)
}

/// `%APPDATA%\com.remo.spechy\server\<flavor>`, one folder per build.
fn server_dir(id: &str) -> PathBuf {
    crate::settings::data_dir().join("server").join(id)
}

fn binary(id: &str) -> PathBuf {
    server_dir(id).join("Release").join("whisper-server.exe")
}

fn is_installed(id: &str) -> bool {
    binary(id).is_file()
}

fn installed_flavors() -> Vec<String> {
    FLAVORS
        .iter()
        .filter(|flavor| is_installed(flavor.id))
        .map(|flavor| flavor.id.to_string())
        .collect()
}

/// The build that suits this PC: CUDA only pays off on an NVIDIA card.
pub fn preferred_flavor(hw: &HardwareProfile) -> &'static str {
    if hw.gpu_vendor == "nvidia" {
        "cuda"
    } else {
        "cpu"
    }
}

/// The installed build to run: the preferred one when it is there, otherwise
/// whatever the user installed.
fn active_flavor(hw: &HardwareProfile) -> Option<&'static str> {
    let preferred = preferred_flavor(hw);
    if is_installed(preferred) {
        return Some(preferred);
    }
    FLAVORS.iter().map(|flavor| flavor.id).find(|id| is_installed(id))
}

fn threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get().min(16)).unwrap_or(4)
}

fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

// ---------- Status ----------

fn log_path(hw: &HardwareProfile) -> Option<PathBuf> {
    active_flavor(hw).map(|id| server_dir(id).join("server.log"))
}

/// Last lines of the server log, so the UI can explain a failure.
fn log_tail(hw: &HardwareProfile, lines: usize) -> Vec<String> {
    let Some(path) = log_path(hw) else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let all: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    all[all.len().saturating_sub(lines)..].iter().map(|line| line.to_string()).collect()
}

pub fn status() -> LocalServerStatus {
    let hw = crate::hardware::detect();
    let mut running = false;
    let mut flavor_id = None;
    let mut port = 0;
    let mut model_id = None;
    let mut model_path = None;

    if let Ok(mut guard) = SERVER.lock() {
        // A server that died on its own must not look like it is still running.
        let exited = match guard.as_mut() {
            Some(run) => matches!(run.child.try_wait(), Ok(Some(_))),
            None => false,
        };
        if exited {
            *guard = None;
        }
        if let Some(run) = guard.as_ref() {
            running = true;
            flavor_id = Some(run.flavor.clone());
            port = run.port;
            model_id = Some(run.model_id.clone());
            model_path = Some(run.model_path.clone());
        }
    }

    LocalServerStatus {
        installed: !installed_flavors().is_empty(),
        installed_flavors: installed_flavors(),
        preferred_flavor: preferred_flavor(&hw).to_string(),
        running,
        flavor: flavor_id,
        port,
        model_id,
        model_path,
        build: BUILD.to_string(),
        log_tail: log_tail(&hw, 12),
    }
}

// ---------- Install ----------

fn asset_url(flavor: &Flavor) -> String {
    format!(
        "https://github.com/ggml-org/whisper.cpp/releases/download/{}/{}",
        BUILD, flavor.asset
    )
}

/// Download and unpack one build. Safe to call twice: an installed build returns
/// immediately.
pub fn install(flavor_id: &str, progress: impl Fn(Progress)) -> Result<LocalServerStatus, String> {
    let _guard = INSTALL.try_lock().map_err(|_| "A server download is already running.".to_string())?;
    let flavor = flavor(flavor_id).ok_or_else(|| format!("Unknown server build: {flavor_id}"))?;
    if is_installed(flavor.id) {
        return Ok(status());
    }

    let dir = server_dir(flavor.id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let archive = dir.join("whisper-server.zip.part");
    let _ = std::fs::remove_file(&archive);
    crate::local_models::download_file(
        &asset_url(flavor),
        &archive,
        flavor.size_bytes,
        flavor.sha256,
        &format!("The {} server build", flavor.label),
        &progress,
    )?;

    let output = Command::new(system_tar())
        .arg("-xf")
        .arg(&archive)
        .arg("-C")
        .arg(&dir)
        .output()
        .map_err(|e| {
            let _ = std::fs::remove_file(&archive);
            format!("Could not unpack the server build: {e}")
        })?;
    let _ = std::fs::remove_file(&archive);
    if !output.status.success() {
        return Err(format!(
            "Could not unpack the server build: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if !is_installed(flavor.id) {
        return Err("The server archive did not contain whisper-server.exe.".into());
    }
    Ok(status())
}

/// Windows ships bsdtar, which unpacks zip. Resolved by absolute path so a
/// different `tar` on PATH cannot be picked up by accident.
fn system_tar() -> PathBuf {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    PathBuf::from(root).join("System32").join("tar.exe")
}

// ---------- Start and stop ----------

/// Start the server for a downloaded model. Any previously started server is
/// stopped first, so only one port is ever in use.
pub fn start(model_id: &str, port: u16) -> Result<LocalServerStatus, String> {
    stop();
    let model = crate::local_models::catalogue()
        .into_iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| format!("Unknown model: {model_id}"))?;
    let path = crate::local_models::models_dir().join(&model.file);
    if !path.metadata().map(|meta| meta.len() == model.size_bytes).unwrap_or(false) {
        return Err(format!("{} is not downloaded yet.", model.name));
    }

    let hw = crate::hardware::detect();
    let flavor_id = active_flavor(&hw).ok_or("The local whisper.cpp server is not installed yet.")?;
    let flavor = flavor(flavor_id).expect("installed flavors come from the table");
    if !port_free(port) {
        return Err(format!(
            "Port {port} is already in use by another program. Choose a different port."
        ));
    }

    let log = server_dir(flavor.id).join("server.log");
    let stdout = std::fs::File::create(&log).map_err(|e| format!("Could not write {}: {e}", log.display()))?;
    let stderr = stdout.try_clone().map_err(|e| e.to_string())?;

    let mut command = Command::new(binary(flavor.id));
    command
        .arg("-m")
        .arg(&path)
        .arg("-t")
        .arg(threads().to_string())
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    // Without this a console window flashes up next to the tray app.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start the local server: {e}"))?;
    if let Err(error) = wait_ready(port, &mut child, flavor.label) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    *SERVER.lock().map_err(|e| e.to_string())? = Some(Running {
        child,
        flavor: flavor.id.to_string(),
        port,
        model_id: model.id.clone(),
        model_path: path.to_string_lossy().to_string(),
    });
    Ok(status())
}

/// Stop the server this app started. Does nothing when none is running.
pub fn stop() -> LocalServerStatus {
    if let Ok(mut guard) = SERVER.lock() {
        if let Some(mut run) = guard.take() {
            let _ = run.child.kill();
            let _ = run.child.wait();
        }
    }
    status()
}

/// Poll `/health` until the model is loaded. Loading a large model from disk can
/// take a few seconds, so this waits rather than failing straight away.
fn wait_ready(port: u16, child: &mut Child, label: &str) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/health");
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(3)).build();
    let deadline = Instant::now() + Duration::from_secs(90);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return Err(format!("The {label} server stopped right after starting. Check the log below."));
        }
        if let Ok(response) = agent.get(&url).call() {
            if response.status() == 200 {
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    Err(format!("The {label} server did not answer in time. Check the log below."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flavours_are_unique_and_verifiable() {
        let mut ids: Vec<_> = FLAVORS.iter().map(|flavor| flavor.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), FLAVORS.len(), "duplicate flavour id");
        for flavor in FLAVORS {
            assert!(flavor.size_bytes > 0);
            assert_eq!(flavor.sha256.len(), 64, "{} has no checksum", flavor.id);
            assert!(flavor.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert!(asset_url(flavor).starts_with("https://github.com/ggml-org/whisper.cpp/releases/download/"));
        }
    }

    #[test]
    fn cuda_is_only_preferred_on_nvidia() {
        let mut hw = HardwareProfile { gpu_vendor: "nvidia".into(), ..Default::default() };
        assert_eq!(preferred_flavor(&hw), "cuda");
        hw.gpu_vendor = "amd".into();
        assert_eq!(preferred_flavor(&hw), "cpu");
        hw.gpu_vendor = "none".into();
        assert_eq!(preferred_flavor(&hw), "cpu");
    }

    #[test]
    fn unknown_flavours_and_ports_are_reported() {
        assert!(flavor("vulkan").is_none());
        assert!(flavor("cpu").is_some());
        // Port 0 is always bindable, so this stays deterministic.
        assert!(port_free(0));
    }

    #[test]
    fn stopping_an_idle_server_is_not_an_error() {
        let status = stop();
        assert!(!status.running);
    }
}
