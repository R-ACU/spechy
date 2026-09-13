//! Public release discovery and verified in-app installer downloads.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::{Read, Write}, path::{Path, PathBuf}, sync::Mutex};

static READY: Mutex<Option<(PathBuf, String)>> = Mutex::new(None);
static DOWNLOAD: Mutex<()> = Mutex::new(());
static STATUS: Mutex<DownloadStatus> = Mutex::new(DownloadStatus { downloading: false, version: None, progress: None, error: None });

#[derive(Clone, Serialize)]
pub struct DownloadStatus {
    downloading: bool,
    version: Option<String>,
    progress: Option<Progress>,
    error: Option<String>,
}

pub fn status() -> Result<DownloadStatus, String> {
    STATUS.lock().map(|value| value.clone()).map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
pub struct Progress { pub downloaded: u64, pub total: Option<u64> }

fn checksum(text: &str) -> Result<String, String> {
    let matches: Vec<_> = text.lines().filter_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?;
        (name.trim_start_matches('*') == "Spechy-Setup.exe" && hash.len() == 64
            && hash.bytes().all(|c| c.is_ascii_hexdigit())).then(|| hash.to_ascii_lowercase())
    }).collect();
    if matches.len() != 1 { return Err("The release checksum is missing or invalid.".into()); }
    Ok(matches[0].clone())
}

fn verify(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 { break; }
        hash.update(&buffer[..count]);
    }
    if format!("{:x}", hash.finalize()) != expected {
        return Err("The download failed verification. Please download the update again.".into());
    }
    Ok(())
}

pub fn download(current: &str, cache: &Path, progress: impl Fn(Progress)) -> Result<String, String> {
    let _guard = DOWNLOAD.try_lock().map_err(|_| "An update is already downloading.")?;
    {
        let mut status = STATUS.lock().map_err(|e| e.to_string())?;
        status.downloading = true;
        status.error = None;
        status.progress = None;
    }
    let result = download_inner(current, cache, |value| {
        if let Ok(mut status) = STATUS.lock() { status.progress = Some(value.clone()); }
        progress(value);
    });
    if let Ok(mut status) = STATUS.lock() {
        status.downloading = false;
        match &result {
            Ok(version) => status.version = Some(version.clone()),
            Err(error) => status.error = Some(error.clone()),
        }
    }
    result
}

fn download_inner(current: &str, cache: &Path, progress: impl Fn(Progress)) -> Result<String, String> {
    let release = check(current)?;
    if !release.available { return Err("You are already up to date.".into()); }
    let checksum_url = release.download_url.rsplit_once('/').ok_or("Invalid release URL.")?.0.to_owned() + "/SHA256SUMS.txt";
    let mut sums = String::new();
    ureq::get(&checksum_url).set("User-Agent", "Spechy").timeout(std::time::Duration::from_secs(30))
        .call().map_err(|e| format!("Could not download the checksum: {e}"))?
        .into_reader().take(8192).read_to_string(&mut sums).map_err(|e| e.to_string())?;
    let expected = checksum(&sums)?;
    let directory = cache.join("updates").join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join("Spechy-Setup.exe");
    let result = (|| {
        let response = ureq::get(&release.download_url).set("User-Agent", "Spechy")
            .timeout(std::time::Duration::from_secs(300)).call()
            .map_err(|e| format!("Could not download the update: {e}"))?;
        let total = response.header("Content-Length").and_then(|s| s.parse::<u64>().ok());
        let mut reader = response.into_reader();
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| e.to_string())?;
        let mut buffer = [0u8; 65536];
        let mut downloaded = 0;
        progress(Progress { downloaded, total });
        loop {
            let count = reader.read(&mut buffer).map_err(|e| format!("Download interrupted: {e}"))?;
            if count == 0 { break; }
            downloaded += count as u64;
            if downloaded > 256 * 1024 * 1024 { return Err("The installer exceeds the download limit.".into()); }
            file.write_all(&buffer[..count]).map_err(|e| e.to_string())?;
            progress(Progress { downloaded, total });
        }
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        verify(&path, &expected)?;
        let mut ready = READY.lock().map_err(|e| e.to_string())?;
        if let Some((old, _)) = ready.replace((path.clone(), expected)) {
            let _ = std::fs::remove_file(&old);
            if let Some(parent) = old.parent() { let _ = std::fs::remove_dir(parent); }
        }
        Ok(release.version)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&directory);
    }
    result
}

pub fn install() -> Result<(), String> {
    let ready = READY.lock().map_err(|e| e.to_string())?;
    let (path, expected) = ready.as_ref().ok_or("Download the update first.")?;
    verify(path, expected)?;
    // Tauri's NSIS installer supports silent update mode and relaunch on success.
    std::process::Command::new(path).args(["/S", "/UPDATE", "/R"]).spawn()
        .map_err(|e| format!("Could not start the installer: {e}"))?;
    Ok(())
}

pub const RELEASES_URL: &str = "https://github.com/R-ACU/spechy-releases/releases/latest";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    available: bool,
    download_url: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

fn version_parts(version: &str) -> Result<[u64; 3], String> {
    let parts: Vec<_> = version.trim_start_matches('v').split('.').collect();
    if parts.len() != 3 { return Err("The release version is invalid.".into()); }
    let mut result = [0; 3];
    for (index, part) in parts.iter().enumerate() {
        result[index] = part.parse().map_err(|_| "The release version is invalid.")?;
    }
    Ok(result)
}

pub fn check(current: &str) -> Result<UpdateInfo, String> {
    let release: Release = ureq::get("https://api.github.com/repos/R-ACU/spechy-releases/releases/latest")
        .set("User-Agent", "Spechy")
        .set("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(15))
        .call().map_err(|error| format!("Could not check for updates. Try again later. {error}"))?
        .into_json().map_err(|_| "GitHub returned an invalid release response.")?;
    let asset = release.assets.iter().find(|asset| asset.name == "Spechy-Setup.exe")
        .ok_or("This release has no Windows installer yet.")?;
    if !asset.browser_download_url.starts_with("https://github.com/R-ACU/spechy-releases/releases/download/") {
        return Err("The release download address is invalid.".into());
    }
    Ok(UpdateInfo {
        available: version_parts(&release.tag_name)? > version_parts(current)?,
        version: release.tag_name.trim_start_matches('v').into(),
        download_url: asset.browser_download_url.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Downloads the public installer from GitHub; run explicitly before release"]
    fn public_release_download_is_verified_and_ready() {
        let cache = std::env::temp_dir().join(format!("spechy-update-test-{}", uuid::Uuid::new_v4()));
        let version = download("0.0.0", &cache, |_| {}).unwrap();
        assert_eq!(status().unwrap().version, Some(version));
        assert!(!status().unwrap().downloading);
        let (path, hash) = READY.lock().unwrap().take().unwrap();
        verify(&path, &hash).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > 1_000_000);
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(path.parent().unwrap()).unwrap();
        std::fs::remove_dir(cache.join("updates")).unwrap();
        std::fs::remove_dir(cache).unwrap();
    }
    #[test]
    fn checksum_requires_correct_filename_and_hash() {
        let hash = "ab".repeat(32);
        assert_eq!(checksum(&format!("{hash}  Spechy-Setup.exe")).unwrap(), hash);
        assert!(checksum(&format!("{hash}  other.exe")).is_err());
        assert!(checksum("broken  Spechy-Setup.exe").is_err());
    }
    #[test]
    fn rejects_modified_installer() {
        let path = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::write(&path, b"installer").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"installer"));
        assert!(verify(&path, &hash).is_ok());
        std::fs::write(&path, b"modified").unwrap();
        assert!(verify(&path, &hash).is_err());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn compares_versions_numerically_and_rejects_invalid_releases() {
        assert!(version_parts("v0.10.0").unwrap() > version_parts("0.9.0").unwrap());
        assert_eq!(version_parts("v0.1.0").unwrap(), version_parts("0.1.0").unwrap());
        assert!(version_parts("1.0").is_err());
        assert!(version_parts("1.0.0-beta").is_err());
    }
}
