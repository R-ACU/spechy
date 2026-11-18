//! Vosk (alphacep/vosk-api, Apache 2.0) for Voice Snake: the pinned downloads, their
//! install into the data folder and a thin binding to the C API, loaded at runtime.
//!
//! Nothing is linked at build time, so the installer and the CI workflow stay as they are,
//! and a PC that never plays Voice Snake never downloads or loads any of it.
//!
//! Layout under `<data dir>/vosk/`: one folder per archive, named like its top folder
//! (`vosk-win64-0.3.45`, `vosk-model-small-en-us-0.15`, `vosk-model-small-de-0.15`). An archive is downloaded to
//! `<name>.zip.part`, checked (size and SHA-256), unpacked into `<name>.tmp` and only then
//! renamed into place, so a broken or cancelled download never looks installed.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

/// One pinned download.
pub struct Asset {
    /// Shown in the download progress, e.g. "German voice model".
    pub label: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    /// Folder under `vosk/`, identical to the top folder inside the archive.
    pub dir: &'static str,
    /// A file inside `dir` that exists once the asset is installed.
    pub check: &'static str,
}

/// Native library, Windows x64: libvosk.dll plus its MinGW runtime DLLs.
#[cfg(all(windows, target_arch = "x86_64"))]
pub static LIBRARY: Option<Asset> = Some(Asset {
    label: "Speech engine",
    url: "https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-win64-0.3.45.zip",
    size: 14_882_445,
    sha256: "f1dcc9cca460630f81ea8f71794f69c80bed6556d2a4e6237b5785e1d2dff34b",
    dir: "vosk-win64-0.3.45",
    check: "libvosk.dll",
});

/// Native library, Linux x86_64.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub static LIBRARY: Option<Asset> = Some(Asset {
    label: "Speech engine",
    url: "https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-linux-x86_64-0.3.45.zip",
    size: 7_185_065,
    sha256: "bbdc8ed85c43979f6443142889770ea95cbfbc56cffb5c5dcd73afa875c5fbb2",
    dir: "vosk-linux-x86_64-0.3.45",
    check: "libvosk.so",
});

/// No prebuilt library for this platform: Voice Snake stays on the keyboard.
#[cfg(not(any(all(windows, target_arch = "x86_64"), all(target_os = "linux", target_arch = "x86_64"))))]
pub static LIBRARY: Option<Asset> = None;

pub static MODEL_DE: Asset = Asset {
    label: "German voice model",
    url: "https://alphacephei.com/vosk/models/vosk-model-small-de-0.15.zip",
    size: 46_499_967,
    sha256: "b7e53c90b1f0a38456f4cd62b366ecd58803cd97cd42b06438e2c131713d5e43",
    dir: "vosk-model-small-de-0.15",
    check: "am/final.mdl",
};

pub static MODEL_EN: Asset = Asset {
    label: "English voice model",
    url: "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip",
    size: 41_205_931,
    sha256: "30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498",
    dir: "vosk-model-small-en-us-0.15",
    check: "am/final.mdl",
};

/// `<data dir>/vosk`.
pub fn root() -> PathBuf {
    crate::settings::data_dir().join("vosk")
}

pub fn path(asset: &Asset) -> PathBuf {
    root().join(asset.dir)
}

pub fn installed(asset: &Asset) -> bool {
    path(asset).join(asset.check).is_file()
}

// ------------------------------------------------------------------ install

/// Progress of `install`: `progress` runs from 0 to 1 over all missing archives.
pub struct Step {
    /// "download" or "unpack".
    pub stage: &'static str,
    pub label: &'static str,
    pub progress: f32,
    /// Bytes of everything that is downloaded in this run.
    pub total: u64,
}

#[derive(Debug, PartialEq)]
pub enum InstallError {
    Cancelled,
    Failed(String),
}

/// Two sessions must never write the same `.part` file: a replaced session finishes its
/// cancelled download before the next one may start.
static INSTALL: Mutex<()> = Mutex::new(());

/// Download and unpack every asset that is not installed yet. Returns at once when
/// everything is there. `cancel` is checked between reads.
pub fn install(assets: &[&Asset], cancel: &AtomicBool, step: &mut dyn FnMut(Step)) -> Result<(), InstallError> {
    let _guard = INSTALL.lock().unwrap_or_else(|e| e.into_inner());
    let missing: Vec<&Asset> = assets.iter().copied().filter(|a| !installed(a)).collect();
    if missing.is_empty() {
        return Ok(());
    }
    let root = root();
    std::fs::create_dir_all(&root).map_err(|e| InstallError::Failed(format!("Could not create {}: {e}", root.display())))?;
    let total: u64 = missing.iter().map(|a| a.size).sum();
    let mut done: u64 = 0;
    for asset in missing {
        let part = root.join(format!("{}.zip.part", asset.dir));
        let result = fetch(asset, &part, cancel, &mut |bytes| {
            step(Step { stage: "download", label: asset.label, progress: (done + bytes) as f32 / total as f32, total });
        })
        .and_then(|()| {
            step(Step { stage: "unpack", label: asset.label, progress: (done + asset.size) as f32 / total as f32, total });
            unpack(asset, &part, &root, cancel)
        });
        let _ = std::fs::remove_file(&part);
        result?;
        done += asset.size;
    }
    Ok(())
}

/// Stream one archive to `part`, keeping it only when size and SHA-256 match.
fn fetch(asset: &Asset, part: &Path, cancel: &AtomicBool, progress: &mut dyn FnMut(u64)) -> Result<(), InstallError> {
    let failed = |e: String| InstallError::Failed(e);
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        // Per read: a stalled connection fails, and a cancel waits at most this long.
        .timeout_read(Duration::from_secs(30))
        .build();
    let response = agent
        .get(asset.url)
        .set("User-Agent", "Spechy")
        .call()
        .map_err(|e| failed(crate::stt::map_error("The download host", e)))?;
    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(part).map_err(|e| failed(format!("Could not write {}: {e}", part.display())))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 131_072];
    let mut got: u64 = 0;
    let mut last = Instant::now();
    progress(0);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(InstallError::Cancelled);
        }
        let n = reader.read(&mut buffer).map_err(|e| failed(format!("Download interrupted: {e}")))?;
        if n == 0 {
            break;
        }
        got += n as u64;
        if got > asset.size {
            return Err(failed(format!("{} is larger than expected.", asset.label)));
        }
        hasher.update(&buffer[..n]);
        file.write_all(&buffer[..n]).map_err(|e| failed(format!("Could not write {}: {e}", part.display())))?;
        if last.elapsed() >= Duration::from_millis(120) {
            last = Instant::now();
            progress(got);
        }
    }
    file.sync_all().map_err(|e| failed(e.to_string()))?;
    progress(got);
    if got != asset.size {
        return Err(failed(format!("{} stopped early ({got} of {} bytes). Please try again.", asset.label, asset.size)));
    }
    if format!("{:x}", hasher.finalize()) != asset.sha256 {
        return Err(failed(format!("{} did not pass its checksum check. Please try again.", asset.label)));
    }
    Ok(())
}

/// Unpack a verified archive into `<dir>.tmp`, then rename its top folder into place.
fn unpack(asset: &Asset, archive: &Path, root: &Path, cancel: &AtomicBool) -> Result<(), InstallError> {
    let failed = |e: String| InstallError::Failed(e);
    let tmp = root.join(format!("{}.tmp", asset.dir));
    let _ = std::fs::remove_dir_all(&tmp);
    let result = (|| {
        let file = std::fs::File::open(archive).map_err(|e| failed(e.to_string()))?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| failed(format!("{} is not a valid archive: {e}", asset.label)))?;
        for i in 0..zip.len() {
            if cancel.load(Ordering::Relaxed) {
                return Err(InstallError::Cancelled);
            }
            let mut entry = zip.by_index(i).map_err(|e| failed(e.to_string()))?;
            // Never trust archive paths: no absolute paths, no `..`.
            let Some(relative) = entry.enclosed_name() else { continue };
            let out = tmp.join(relative);
            if entry.is_dir() {
                std::fs::create_dir_all(&out).map_err(|e| failed(e.to_string()))?;
                continue;
            }
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| failed(e.to_string()))?;
            }
            let mut target = std::fs::File::create(&out).map_err(|e| failed(format!("Could not write {}: {e}", out.display())))?;
            std::io::copy(&mut entry, &mut target).map_err(|e| failed(format!("Could not unpack {}: {e}", asset.label)))?;
        }
        let inner = tmp.join(asset.dir);
        let source = if inner.join(asset.check).is_file() { inner } else { tmp.clone() };
        if !source.join(asset.check).is_file() {
            return Err(failed(format!("{} is missing {}.", asset.label, asset.check)));
        }
        let target = root.join(asset.dir);
        let _ = std::fs::remove_dir_all(&target);
        std::fs::rename(&source, &target).map_err(|e| failed(format!("Could not finish {}: {e}", asset.label)))
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

// ------------------------------------------------------------------ runtime binding

type FnLogLevel = unsafe extern "C" fn(c_int);
type FnModelNew = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type FnFree = unsafe extern "C" fn(*mut c_void);
type FnFindWord = unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int;
type FnRecNewGrm = unsafe extern "C" fn(*mut c_void, f32, *const c_char) -> *mut c_void;
type FnSetInt = unsafe extern "C" fn(*mut c_void, c_int);
type FnAccept = unsafe extern "C" fn(*mut c_void, *const i16, c_int) -> c_int;
type FnText = unsafe extern "C" fn(*mut c_void) -> *const c_char;

/// The C functions of libvosk (signatures from `vosk_api.h` of 0.3.45).
pub struct Api {
    _lib: libloading::Library,
    model_new: FnModelNew,
    model_free: FnFree,
    model_find_word: FnFindWord,
    recognizer_new_grm: FnRecNewGrm,
    recognizer_set_words: FnSetInt,
    accept_waveform_s: FnAccept,
    result: FnText,
    partial_result: FnText,
    #[cfg_attr(not(test), allow(dead_code))]
    final_result: FnText,
    recognizer_free: FnFree,
}

/// Loaded once and kept for the life of the process: unloading a MinGW C++ runtime
/// while its static objects are alive is a classic crash on exit.
static API: Mutex<Option<Arc<Api>>> = Mutex::new(None);

/// The library, loading it on first use. Fails when it is not installed.
pub fn api() -> Result<Arc<Api>, String> {
    let mut slot = API.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(api) = slot.as_ref() {
        return Ok(Arc::clone(api));
    }
    let asset = LIBRARY.as_ref().ok_or("Voice control is not available on this platform.")?;
    let file = path(asset).join(asset.check);
    let api = Arc::new(unsafe { load(&file) }.map_err(|e| format!("Could not load the speech engine: {e}"))?);
    *slot = Some(Arc::clone(&api));
    Ok(api)
}

unsafe fn load(file: &Path) -> Result<Api, libloading::Error> {
    // The MinGW runtime DLLs sit next to libvosk.dll. LOAD_WITH_ALTERED_SEARCH_PATH makes
    // Windows look for them there first instead of next to spechy.exe or on PATH (where
    // an unrelated libstdc++-6.dll, e.g. from Git, could be picked up).
    #[cfg(windows)]
    let lib: libloading::Library = {
        const LOAD_WITH_ALTERED_SEARCH_PATH: u32 = 0x0000_0008;
        libloading::os::windows::Library::load_with_flags(file, LOAD_WITH_ALTERED_SEARCH_PATH)?.into()
    };
    #[cfg(not(windows))]
    let lib = libloading::Library::new(file)?;

    let set_log_level: FnLogLevel = *lib.get(b"vosk_set_log_level\0")?;
    let api = Api {
        model_new: *lib.get(b"vosk_model_new\0")?,
        model_free: *lib.get(b"vosk_model_free\0")?,
        model_find_word: *lib.get(b"vosk_model_find_word\0")?,
        recognizer_new_grm: *lib.get(b"vosk_recognizer_new_grm\0")?,
        recognizer_set_words: *lib.get(b"vosk_recognizer_set_words\0")?,
        accept_waveform_s: *lib.get(b"vosk_recognizer_accept_waveform_s\0")?,
        result: *lib.get(b"vosk_recognizer_result\0")?,
        partial_result: *lib.get(b"vosk_recognizer_partial_result\0")?,
        final_result: *lib.get(b"vosk_recognizer_final_result\0")?,
        recognizer_free: *lib.get(b"vosk_recognizer_free\0")?,
        _lib: lib,
    };
    // Kaldi logs every model load to stderr; nobody reads it.
    set_log_level(-1);
    Ok(api)
}

/// A loaded acoustic model plus graph. Vosk allows sharing one model between
/// recognizers on different threads.
pub struct Model {
    api: Arc<Api>,
    ptr: NonNull<c_void>,
}

unsafe impl Send for Model {}
unsafe impl Sync for Model {}

impl Model {
    /// Load a model folder. Takes about a second for the small models.
    pub fn load(api: &Arc<Api>, dir: &Path) -> Result<Arc<Model>, String> {
        let path = c_path(dir)?;
        let ptr = unsafe { (api.model_new)(path.as_ptr()) };
        let ptr = NonNull::new(ptr).ok_or_else(|| format!("Could not load the voice model in {}.", dir.display()))?;
        Ok(Arc::new(Model { api: Arc::clone(api), ptr }))
    }

    /// Whether the model's vocabulary has this word.
    pub fn knows(&self, word: &str) -> bool {
        let Ok(word) = CString::new(word) else { return false };
        unsafe { (self.api.model_find_word)(self.ptr.as_ptr(), word.as_ptr()) >= 0 }
    }
}

impl Drop for Model {
    fn drop(&mut self) {
        unsafe { (self.api.model_free)(self.ptr.as_ptr()) }
    }
}

/// One recognizer: owned by one thread at a time.
pub struct Recognizer {
    model: Arc<Model>,
    ptr: NonNull<c_void>,
}

unsafe impl Send for Recognizer {}

impl Recognizer {
    /// A recognizer limited to `grammar`, a closed list of phrases. Word lists with
    /// confidences in final results. Partial words stay off: with them Vosk holds a
    /// grammar word back until the utterance ends (about 0.9 s after the word), without
    /// them it shows up while it is still being said.
    pub fn new(model: &Arc<Model>, sample_rate: u32, grammar: &[&str]) -> Result<Recognizer, String> {
        let api = &model.api;
        let json = CString::new(serde_json::to_string(grammar).unwrap_or_default()).map_err(|e| e.to_string())?;
        let ptr = unsafe { (api.recognizer_new_grm)(model.ptr.as_ptr(), sample_rate as f32, json.as_ptr()) };
        let ptr = NonNull::new(ptr).ok_or("Could not create a speech recognizer.")?;
        unsafe { (api.recognizer_set_words)(ptr.as_ptr(), 1) };
        Ok(Recognizer { model: Arc::clone(model), ptr })
    }

    /// Feed mono 16 bit samples. True when an utterance just ended: read `result` then.
    pub fn accept(&mut self, samples: &[i16]) -> bool {
        if samples.is_empty() {
            return false;
        }
        let n = samples.len().min(c_int::MAX as usize) as c_int;
        unsafe { (self.model.api.accept_waveform_s)(self.ptr.as_ptr(), samples.as_ptr(), n) == 1 }
    }

    pub fn result(&mut self) -> String {
        self.text(self.model.api.result)
    }

    pub fn partial(&mut self) -> String {
        self.text(self.model.api.partial_result)
    }

    /// Flush: the result of whatever audio is still pending. Only the WAV tests need it.
    #[cfg(test)]
    pub fn final_result(&mut self) -> String {
        self.text(self.model.api.final_result)
    }

    /// The returned buffer belongs to the recognizer and is only valid until the next
    /// call, so it is copied right away.
    fn text(&mut self, f: FnText) -> String {
        let ptr = unsafe { f(self.ptr.as_ptr()) };
        if ptr.is_null() {
            return String::new();
        }
        unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
    }
}

impl Drop for Recognizer {
    fn drop(&mut self) {
        unsafe { (self.model.api.recognizer_free)(self.ptr.as_ptr()) }
    }
}

/// Model paths go through C `fopen`, which reads narrow strings in the ANSI code page on
/// Windows. A user folder with an umlaut (`C:\Users\Jürgen`) would break as UTF-8, so a
/// non-ASCII path is handed over as its 8.3 short form.
fn c_path(dir: &Path) -> Result<CString, String> {
    let text = dir.to_string_lossy().to_string();
    #[cfg(windows)]
    if !text.is_ascii() {
        if let Some(short) = short_path(dir).filter(|s| s.is_ascii()) {
            return CString::new(short).map_err(|e| e.to_string());
        }
        return Err(format!("The voice model folder {text} has characters the speech engine cannot open."));
    }
    CString::new(text).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn short_path(dir: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetShortPathNameW;
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut buf = vec![0u16; 1024];
    let n = unsafe { GetShortPathNameW(PCWSTR(wide.as_ptr()), Some(&mut buf)) } as usize;
    (n > 0 && n < buf.len()).then(|| String::from_utf16_lossy(&buf[..n]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive(dir: &Path, entries: &[(&str, &[u8])]) -> PathBuf {
        use zip::write::SimpleFileOptions;
        let path = dir.join("test.zip.part");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, data) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    fn asset() -> Asset {
        Asset { label: "Test", url: "", size: 0, sha256: "", dir: "pkg-1.0", check: "lib/core.bin" }
    }

    #[test]
    fn unpack_moves_the_top_folder_into_place_and_ignores_escapes() {
        let root = std::env::temp_dir().join(format!("spechy-vosk-unpack-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let zip = archive(&root, &[("pkg-1.0/lib/core.bin", b"core"), ("pkg-1.0/readme", b"hi"), ("../escape.txt", b"x")]);
        unpack(&asset(), &zip, &root, &AtomicBool::new(false)).unwrap();
        assert_eq!(std::fs::read(root.join("pkg-1.0/lib/core.bin")).unwrap(), b"core");
        assert!(!root.join("pkg-1.0.tmp").exists(), "the staging folder is removed");
        assert!(!root.parent().unwrap().join("escape.txt").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn unpack_without_the_check_file_installs_nothing() {
        let root = std::env::temp_dir().join(format!("spechy-vosk-broken-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let zip = archive(&root, &[("pkg-1.0/other.bin", b"x")]);
        assert!(matches!(unpack(&asset(), &zip, &root, &AtomicBool::new(false)), Err(InstallError::Failed(_))));
        assert!(!root.join("pkg-1.0").exists());
        assert!(!root.join("pkg-1.0.tmp").exists());
        // A cancelled unpack leaves nothing behind either.
        let zip = archive(&root, &[("pkg-1.0/lib/core.bin", b"core")]);
        assert_eq!(unpack(&asset(), &zip, &root, &AtomicBool::new(true)), Err(InstallError::Cancelled));
        assert!(!root.join("pkg-1.0").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
