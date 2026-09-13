//! Curated local speech models for the settings library: which ones fit this PC,
//! which ones are good in German, and a one-click download into the models folder.
//!
//! Everything here is served by whisper.cpp. Spechy does not run a server itself:
//! it talks to the OpenAI-compatible endpoint that a local server exposes, exactly
//! like it does for any other custom provider.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::model::{Fit, HardwareProfile, LocalModel, LocalModelFit, ModelInfo};

/// Pinned revision of `ggerganov/whisper.cpp`, so a file and its checksum stay
/// stable. Bump this together with `size_bytes` and `sha256` when adding models.
const GGML_BASE: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1";
/// Memory Windows and Spechy should be able to keep before a model counts as comfortable.
const RAM_HEADROOM_MB: u64 = 2048;

static DOWNLOAD: Mutex<()> = Mutex::new(());

#[derive(Clone, serde::Serialize)]
pub struct Progress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// `%APPDATA%\com.remo.spechy\models`, next to settings and history.
pub fn models_dir() -> PathBuf {
    crate::settings::data_dir().join("models")
}

// ---------- Catalogue ----------

#[allow(clippy::too_many_arguments)]
fn entry(
    id: &str,
    name: &str,
    family: &str,
    params: &str,
    size_bytes: u64,
    sha256: &str,
    ram_mb: u64,
    vram_mb: u64,
    quality: u8,
    speed: u8,
    german: u8,
    note: &str,
) -> LocalModel {
    LocalModel {
        id: id.into(),
        name: name.into(),
        backend: "whisper_cpp".into(),
        family: family.into(),
        params: params.into(),
        size_bytes,
        sha256: sha256.into(),
        ram_mb,
        vram_mb,
        quality,
        speed,
        german,
        languages: "99 languages".into(),
        english_only: false,
        license: "MIT (OpenAI Whisper)".into(),
        note: note.into(),
        file: format!("{id}.bin"),
        url: format!("{base}/{id}.bin", base = GGML_BASE),
    }
}

/// The curated catalogue. Sizes and checksums come from the pinned revision;
/// memory figures are practical values for whisper.cpp, not the theoretical minimum.
pub fn catalogue() -> Vec<LocalModel> {
    vec![
        entry(
            "ggml-tiny",
            "Whisper Tiny",
            "Whisper",
            "39M",
            77_691_713,
            "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
            500,
            400,
            1,
            5,
            1,
            "Fastest option and the smallest download. Fine for short English notes, rough on German.",
        ),
        entry(
            "ggml-base",
            "Whisper Base",
            "Whisper",
            "74M",
            147_951_465,
            "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
            700,
            500,
            2,
            5,
            2,
            "A small step up from Tiny. Understands simple German, but still misses words.",
        ),
        entry(
            "ggml-small",
            "Whisper Small",
            "Whisper",
            "244M",
            487_601_967,
            "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
            1200,
            900,
            3,
            4,
            3,
            "Good all-rounder for notebooks without a dedicated GPU. Usable German accuracy.",
        ),
        entry(
            "ggml-medium",
            "Whisper Medium",
            "Whisper",
            "769M",
            1_533_763_059,
            "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
            2400,
            2000,
            4,
            2,
            4,
            "Noticeably better German and punctuation. Slow on a CPU, comfortable on a GPU.",
        ),
        entry(
            "ggml-large-v3-turbo",
            "Whisper Large v3 Turbo",
            "Whisper Large v3",
            "809M",
            1_624_555_275,
            "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
            2600,
            2100,
            4,
            4,
            4,
            "Best speed-to-accuracy ratio. Very good German and runs comfortably on an 8 GB GPU.",
        ),
        entry(
            "ggml-large-v3",
            "Whisper Large v3",
            "Whisper Large v3",
            "1550M",
            3_095_033_483,
            "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
            4200,
            3500,
            5,
            2,
            5,
            "Highest accuracy, especially for German and mixed German/English speech. Wants a strong GPU.",
        ),
    ]
}

// ---------- Fit and recommendation ----------

/// Can this PC hold the model? GPU first, then system memory for CPU inference.
pub fn fit_for(model: &LocalModel, hw: &HardwareProfile) -> Fit {
    if model.vram_mb > 0 && hw.vram_mb >= model.vram_mb {
        return Fit::Great;
    }
    if hw.total_ram_mb == 0 {
        // Unknown hardware: never pretend something is too large.
        return Fit::Good;
    }
    if hw.total_ram_mb >= model.ram_mb + RAM_HEADROOM_MB {
        Fit::Good
    } else if hw.total_ram_mb >= model.ram_mb {
        Fit::Tight
    } else {
        Fit::TooBig
    }
}

/// A GPU makes quality the bottleneck; on the CPU, speed decides whether dictation
/// still feels instant. German accuracy only counts when the user dictates German.
pub fn score(model: &LocalModel, fit: Fit, prefers_german: bool) -> i64 {
    let fit_bonus = match fit {
        Fit::Great => 40,
        Fit::Good => 22,
        Fit::Tight => 4,
        Fit::TooBig => -1000,
    };
    let (quality_weight, speed_weight) = if fit == Fit::Great { (14, 6) } else { (10, 12) };
    let german_weight = if prefers_german { 14 } else { 6 };
    model.german as i64 * german_weight
        + model.quality as i64 * quality_weight
        + model.speed as i64 * speed_weight
        + fit_bonus
}

fn reason(model: &LocalModel, fit: Fit, hw: &HardwareProfile) -> String {
    match fit {
        Fit::Great => format!("Runs on your {}", hw.gpu_name),
        Fit::Good if hw.total_ram_mb == 0 => "Hardware could not be read, so nothing is ruled out.".into(),
        Fit::Good => format!(
            "Fits in your {} RAM (about {} free right now).",
            gb(hw.total_ram_mb),
            gb(hw.available_ram_mb)
        ),
        Fit::Tight => format!("Fits in {} RAM, but barely. Close heavy apps while dictating.", gb(hw.total_ram_mb)),
        Fit::TooBig => format!("Needs about {} RAM, this PC has {}.", gb(model.ram_mb), gb(hw.total_ram_mb)),
    }
}

fn gb(mb: u64) -> String {
    format!("{:.1} GB", mb as f64 / 1024.0)
}

fn fit_entry(model: &LocalModel, hw: &HardwareProfile, prefers_german: bool) -> LocalModelFit {
    let fit = fit_for(model, hw);
    let path = models_dir().join(&model.file);
    let installed = looks_installed(model);
    LocalModelFit {
        model: model.clone(),
        fit,
        score: score(model, fit, prefers_german),
        recommended: false,
        installed,
        installed_path: installed.then(|| path.to_string_lossy().to_string()),
        reason: reason(model, fit, hw),
    }
}

/// Score the whole catalogue and mark the single best pick for this machine.
pub fn rank(catalogue: &[LocalModel], hw: &HardwareProfile, prefers_german: bool) -> Vec<LocalModelFit> {
    let mut fits: Vec<LocalModelFit> = catalogue
        .iter()
        .map(|model| fit_entry(model, hw, prefers_german))
        .collect();

    let best = fits
        .iter()
        .enumerate()
        .filter(|(_, entry)| matches!(entry.fit, Fit::Great | Fit::Good))
        .max_by_key(|(_, entry)| entry.score)
        .map(|(index, _)| index)
        .or_else(|| {
            fits.iter()
                .enumerate()
                .filter(|(_, entry)| entry.fit == Fit::Tight)
                .max_by_key(|(_, entry)| entry.score)
                .map(|(index, _)| index)
        });
    if let Some(index) = best {
        fits[index].recommended = true;
    }

    fits.sort_by(|a, b| b.recommended.cmp(&a.recommended).then(b.score.cmp(&a.score)));
    fits
}

/// True when the user dictates German, which is what the German column is scored for.
pub fn prefers_german() -> bool {
    crate::settings::current()
        .dictation_languages
        .iter()
        .any(|language| language.eq_ignore_ascii_case("de"))
}

pub fn hardware() -> HardwareProfile {
    let mut profile = crate::hardware::detect();
    profile.models_dir = models_dir().to_string_lossy().to_string();
    profile
}

/// The whole library scored against this PC, best pick first.
pub fn library() -> Vec<LocalModelFit> {
    rank(&catalogue(), &hardware(), prefers_german())
}

// ---------- Download ----------

/// Fetch one model file into the models folder. The write goes to a `.part` file
/// first, so an interrupted download never looks like an installed model.
pub fn download(id: &str, progress: impl Fn(Progress)) -> Result<LocalModelFit, String> {
    let _guard = DOWNLOAD.try_lock().map_err(|_| "Another model is already downloading.".to_string())?;
    let model = catalogue()
        .into_iter()
        .find(|model| model.id == id)
        .ok_or_else(|| format!("Unknown model: {id}"))?;
    if model.url.trim().is_empty() || model.sha256.is_empty() {
        return Err(format!("{} has to be installed by hand; follow the setup notes instead.", model.name));
    }

    let dir = models_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let target = dir.join(&model.file);
    if verified_model(&target, &model) {
        return Ok(fit_entry(&model, &hardware(), prefers_german()));
    }

    let part = dir.join(format!("{}.part", model.file));
    let _ = std::fs::remove_file(&part);
    if let Err(error) = fetch(&model, &part, &progress) {
        let _ = std::fs::remove_file(&part);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&part, &target) {
        let _ = std::fs::remove_file(&part);
        return Err(format!("Could not finish {}: {error}", model.file));
    }
    Ok(fit_entry(&model, &hardware(), prefers_german()))
}

/// The catalogue entries whose file is already in the models folder, as the model
/// picker wants them. whisper.cpp has no model list endpoint, so this is what the
/// custom picker shows for the whisper.cpp API.
pub fn installed_models() -> Vec<ModelInfo> {
    catalogue()
        .into_iter()
        .filter(looks_installed)
        .map(|model| ModelInfo { id: model.id, name: model.name, audio: true, free: true })
        .collect()
}

/// Cheap check for listings: the right size and a ggml header. The full SHA-256
/// is only computed when a download finishes, or before a reuse.
fn looks_installed(model: &LocalModel) -> bool {
    let path = models_dir().join(&model.file);
    path.metadata().map(|meta| meta.is_file() && meta.len() == model.size_bytes).unwrap_or(false)
        && looks_like_ggml(&path)
}

fn fetch(model: &LocalModel, part: &Path, progress: &impl Fn(Progress)) -> Result<(), String> {
    download_file(&model.url, part, model.size_bytes, &model.sha256, &model.name, progress)?;
    if !looks_like_ggml(part) {
        let _ = std::fs::remove_file(part);
        return Err(format!("{} is not a whisper.cpp model file.", model.name));
    }
    Ok(())
}

/// Stream a download to `part` and only leave it there when its size and SHA-256
/// match. Shared by the model library and the local server download.
pub fn download_file(
    url: &str,
    part: &Path,
    size_bytes: u64,
    sha256: &str,
    label: &str,
    progress: &impl Fn(Progress),
) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        // Per read, not for the whole transfer: model files are hundreds of megabytes.
        .timeout_read(Duration::from_secs(120))
        .build();
    let response = agent
        .get(url)
        .set("User-Agent", "Spechy")
        .call()
        .map_err(|error| crate::stt::map_error("The download host", error))?;

    // Only used for the progress bar; the real size check happens below.
    let total = response.header("Content-Length").and_then(parse_size);

    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(part).map_err(|e| format!("Could not write {}: {e}", part.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 262_144];
    let mut downloaded: u64 = 0;
    progress(Progress { downloaded, total });
    loop {
        let count = reader.read(&mut buffer).map_err(|e| format!("Download interrupted: {e}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        downloaded += count as u64;
        if downloaded > size_bytes {
            let _ = std::fs::remove_file(part);
            return Err(format!("{label} is larger than expected. Please report this."));
        }
        file.write_all(&buffer[..count]).map_err(|e| format!("Could not write {}: {e}", part.display()))?;
        progress(Progress { downloaded, total });
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);

    if downloaded != size_bytes {
        let _ = std::fs::remove_file(part);
        return Err(format!("{label} stopped early ({downloaded} of {size_bytes} bytes). Please try again."));
    }
    if format!("{:x}", hasher.finalize()) != sha256 {
        let _ = std::fs::remove_file(part);
        return Err(format!("{label} did not pass its checksum check. Please download it again."));
    }
    Ok(())
}

fn parse_size(value: &str) -> Option<u64> {
    value.trim().parse::<u64>().ok()
}

fn verified_model(path: &Path, model: &LocalModel) -> bool {
    if !path.metadata().map(|meta| meta.is_file() && meta.len() == model.size_bytes).unwrap_or(false) {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else { return false; };
    let mut hasher = Sha256::new();
    if std::io::copy(&mut file, &mut hasher).is_err() { return false; }
    format!("{:x}", hasher.finalize()) == model.sha256 && looks_like_ggml(path)
}

/// whisper.cpp files start with a ggml container magic; the newer GGUF magic is
/// accepted too so a future catalogue entry keeps working.
fn looks_like_ggml(path: &Path) -> bool {
    let mut magic = [0u8; 4];
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    if file.read_exact(&mut magic).is_err() {
        return false;
    }
    let head = &magic[..];
    head.starts_with(b"lmgg")
        || head.starts_with(b"tjgg")
        || head.starts_with(b"fmgg")
        || head.starts_with(b"ggml")
        || head.starts_with(b"GGUF")
}

/// Delete a downloaded model (and any leftover partial file) and return the
/// refreshed library.
pub fn remove(id: &str) -> Result<Vec<LocalModelFit>, String> {
    let _guard = DOWNLOAD.try_lock().map_err(|_| "A model is downloading. Wait before deleting models.".to_string())?;
    let model = catalogue()
        .into_iter()
        .find(|model| model.id == id)
        .ok_or_else(|| format!("Unknown model: {id}"))?;
    let path = models_dir().join(&model.file);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Could not delete {}: {e}", path.display()))?;
    }
    let _ = std::fs::remove_file(models_dir().join(format!("{}.part", model.file)));
    Ok(library())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hw(ram_mb: u64, vram_mb: u64) -> HardwareProfile {
        HardwareProfile {
            total_ram_mb: ram_mb,
            available_ram_mb: ram_mb / 2,
            cpu_cores: 8,
            cpu_name: "Test CPU".into(),
            gpu_name: if vram_mb > 0 { "Test GPU".into() } else { String::new() },
            vram_mb,
            gpu_vendor: if vram_mb > 0 { "nvidia".into() } else { "none".into() },
            gpus: Vec::new(),
            models_dir: String::new(),
        }
    }

    fn find(id: &str) -> LocalModel {
        catalogue().into_iter().find(|model| model.id == id).unwrap()
    }

    #[test]
    fn small_models_fit_modest_machines_and_big_ones_need_more() {
        let machine = hw(8192, 0);
        assert_eq!(fit_for(&find("ggml-small"), &machine), Fit::Good);
        // 8 GB still holds the largest model, just without a GPU to speed it up.
        assert_eq!(fit_for(&find("ggml-large-v3"), &machine), Fit::Good);

        let small_machine = hw(4096, 0);
        assert_eq!(fit_for(&find("ggml-large-v3-turbo"), &small_machine), Fit::Tight);
        assert_eq!(fit_for(&find("ggml-large-v3"), &small_machine), Fit::TooBig);
    }

    #[test]
    fn a_gpu_turns_a_big_model_into_a_great_fit() {
        let machine = hw(16384, 8192);
        assert_eq!(fit_for(&find("ggml-large-v3"), &machine), Fit::Great);
    }

    #[test]
    fn unknown_hardware_never_rules_a_model_out() {
        let machine = hw(0, 0);
        for model in catalogue() {
            assert_eq!(fit_for(&model, &machine), Fit::Good, "{} was ruled out", model.id);
        }
    }

    #[test]
    fn german_preference_picks_a_german_capable_model() {
        let machine = hw(32768, 12288);
        let ranked = rank(&catalogue(), &machine, true);
        let best = ranked.iter().find(|entry| entry.recommended).unwrap();
        assert!(best.model.german >= 4, "{} is weak in German", best.model.id);
        assert_eq!(ranked[0].model.id, best.model.id, "the recommendation has to sort first");
    }

    #[test]
    fn the_recommendation_always_runs_on_the_machine() {
        let machine = hw(4096, 0);
        let ranked = rank(&catalogue(), &machine, true);
        let best = ranked.iter().find(|entry| entry.recommended).unwrap();
        assert_ne!(best.fit, Fit::TooBig);
    }

    #[test]
    fn a_bigger_gpu_never_scores_a_model_lower() {
        let weak = hw(16384, 4096);
        let strong = hw(32768, 12288);
        for model in catalogue() {
            assert!(
                score(&model, fit_for(&model, &strong), true) >= score(&model, fit_for(&model, &weak), true),
                "{} dropped with better hardware",
                model.id
            );
        }
    }

    #[test]
    fn catalogue_is_complete_and_unique() {
        let list = catalogue();
        assert!(list.len() >= 5);
        let mut ids: Vec<_> = list.iter().map(|model| model.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), list.len(), "duplicate model ids");
        for model in &list {
            assert!(model.url.starts_with("https://"), "{} has no download url", model.id);
            assert_eq!(model.file, format!("{}.bin", model.id));
            assert!(model.size_bytes > 0 && model.ram_mb > 0 && model.vram_mb > 0);
            assert!((1..=5).contains(&model.german), "{} has no German rating", model.id);
            assert!((1..=5).contains(&model.quality));
            assert!((1..=5).contains(&model.speed));
            assert_eq!(model.sha256.len(), 64, "{} has no checksum", model.id);
            assert!(model.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn parses_content_length() {
        assert_eq!(parse_size(" 12345 "), Some(12345));
        assert_eq!(parse_size("not a number"), None);
    }

    #[test]
    fn existing_download_requires_matching_content_not_just_size() {
        let path = std::env::temp_dir().join(format!("spechy-model-{}", uuid::Uuid::new_v4()));
        let bytes = b"lmggtest";
        let mut model = find("ggml-tiny");
        model.size_bytes = bytes.len() as u64;
        model.sha256 = format!("{:x}", Sha256::digest(bytes));
        std::fs::write(&path, bytes).unwrap();
        assert!(verified_model(&path, &model));
        std::fs::write(&path, b"lmggfail").unwrap();
        assert!(!verified_model(&path, &model));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn deletion_is_blocked_while_a_download_owns_the_files() {
        let _guard = DOWNLOAD.lock().unwrap();
        assert!(remove("ggml-tiny").unwrap_err().contains("downloading"));
    }
}
