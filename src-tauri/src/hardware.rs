//! Best-effort hardware profile used to recommend local speech models.
//! Everything here is read-only and non-fatal: when a value cannot be read the
//! caller gets 0 or an empty string instead of an error, so the settings panel
//! keeps working on machines we cannot identify.
#![cfg_attr(not(windows), allow(dead_code))]

use crate::model::{GpuInfo, HardwareProfile};

/// Read what this PC offers. `models_dir` is filled in by the model library,
/// which owns that folder.
pub fn detect() -> HardwareProfile {
    let (total_ram_mb, available_ram_mb) = memory_mb();
    let cpu_cores = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1);
    let gpus = gpu_list();
    let primary = pick_primary(&gpus);
    HardwareProfile {
        total_ram_mb,
        available_ram_mb,
        cpu_cores,
        cpu_name: cpu_name(),
        gpu_name: primary.as_ref().map(|gpu| gpu.name.clone()).unwrap_or_default(),
        vram_mb: primary.as_ref().map(usable_vram_mb).unwrap_or(0),
        gpu_vendor: primary.as_ref().map(|gpu| gpu.vendor.clone()).unwrap_or_else(|| "none".into()),
        gpus,
        models_dir: String::new(),
    }
}

// ---------- CPU ----------

#[cfg(windows)]
fn cpu_name() -> String {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    hklm.open_subkey(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
        .and_then(|key| key.get_value::<String, _>("ProcessorNameString"))
        .map(|name| name.trim().to_string())
        .unwrap_or_else(|_| std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_default())
}

#[cfg(not(windows))]
fn cpu_name() -> String {
    std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_default()
}

// ---------- RAM ----------

#[cfg(windows)]
fn memory_mb() -> (u64, u64) {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    // SAFETY: MEMORYSTATUSEX is plain data, so zeroing it is a valid initial
    // state; dwLength has to be set before the call, as the API requires.
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut status) }.is_ok() {
        (status.ullTotalPhys / 1_048_576, status.ullAvailPhys / 1_048_576)
    } else {
        (0, 0)
    }
}

#[cfg(not(windows))]
fn memory_mb() -> (u64, u64) {
    (0, 0)
}

// ---------- GPU ----------
// The display class registry keys are the only reliable source for dedicated
// video memory without pulling in a COM/DXGI dependency. Each adapter lives in
// a numbered subkey of the class key and stores `DriverDesc` plus the memory
// size under `HardwareInformation`.

#[cfg(windows)]
fn gpu_list() -> Vec<GpuInfo> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;
    const DISPLAY_CLASS: &str = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let Ok(class) = hklm.open_subkey_with_flags(DISPLAY_CLASS, KEY_READ) else {
        return Vec::new();
    };
    let mut gpus = Vec::new();
    for key_name in class.enum_keys().flatten() {
        // Adapter subkeys are numbered "0000", "0001", ...; anything else is not an adapter.
        if key_name.is_empty() || !key_name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(adapter) = class.open_subkey_with_flags(&key_name, KEY_READ) else {
            continue;
        };
        let Ok(name) = adapter.get_value::<String, _>("DriverDesc") else {
            continue;
        };
        let name = name.trim().to_string();
        if name.is_empty() || is_placeholder(&name) {
            continue;
        }
        let bytes = adapter
            .get_raw_value("HardwareInformation.qwMemorySize")
            .ok()
            .or_else(|| adapter.get_raw_value("HardwareInformation.MemorySize").ok())
            .map(|value| value.bytes)
            .unwrap_or_default();
        let vram_mb = decode_memory_bytes(&bytes) / 1_048_576;
        gpus.push(GpuInfo { vendor: vendor_of(&name), name, vram_mb });
    }
    gpus.sort_by(|a, b| b.vram_mb.cmp(&a.vram_mb));
    gpus
}

#[cfg(not(windows))]
fn gpu_list() -> Vec<GpuInfo> {
    Vec::new()
}

/// Windows stores the adapter memory either as a QWORD or as a legacy DWORD/BINARY.
fn decode_memory_bytes(bytes: &[u8]) -> u64 {
    match bytes.len() {
        8 => u64::from_le_bytes(bytes[..8].try_into().unwrap_or([0; 8])),
        4 => u32::from_le_bytes(bytes[..4].try_into().unwrap_or([0; 4])) as u64,
        _ => 0,
    }
}

/// Adapters that only stand in for a missing driver, never a real GPU.
fn is_placeholder(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("microsoft basic display")
        || lower.contains("microsoft remote display")
        || lower.contains("microsoft hyper-v")
        || lower.contains("microsoft indirect display")
        || lower.contains("remote adapter")
}

fn vendor_of(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if lower.contains("nvidia") || lower.contains("geforce") || lower.contains("quadro") || lower.contains("rtx") || lower.contains("gtx") {
        "nvidia".into()
    } else if lower.contains("amd") || lower.contains("radeon") || lower.contains("ryzen") {
        "amd".into()
    } else if lower.contains("intel") || lower.contains("iris") || lower.contains("arc") || lower.contains("uhd graphics") {
        "intel".into()
    } else {
        "other".into()
    }
}

/// Integrated graphics share system memory, so they never unlock GPU inference;
/// whisper.cpp still runs on them, just as a CPU-class device.
pub fn usable_vram_mb(gpu: &GpuInfo) -> u64 {
    let lower = gpu.name.to_ascii_lowercase();
    let integrated = lower.contains("uhd graphics")
        || lower.contains("iris")
        || lower.contains("radeon graphics")
        || lower.contains("vega")
        || lower.contains("graphics 6")
        || lower.contains("graphics 5")
        || lower.contains("integrated");
    if integrated {
        0
    } else {
        gpu.vram_mb
    }
}

fn pick_primary(gpus: &[GpuInfo]) -> Option<GpuInfo> {
    gpus.iter().max_by_key(|gpu| usable_vram_mb(gpu)).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_four_and_eight_byte_sizes() {
        assert_eq!(decode_memory_bytes(&8u64.to_le_bytes()), 8);
        assert_eq!(decode_memory_bytes(&4u32.to_le_bytes()), 4);
        assert_eq!(decode_memory_bytes(&[1, 2, 3]), 0);
        assert_eq!(decode_memory_bytes(&[]), 0);
    }

    #[test]
    fn recognizes_vendors() {
        assert_eq!(vendor_of("NVIDIA GeForce RTX 4070"), "nvidia");
        assert_eq!(vendor_of("AMD Radeon RX 6800 XT"), "amd");
        assert_eq!(vendor_of("Intel(R) Arc(TM) A770 Graphics"), "intel");
        assert_eq!(vendor_of("Some Unknown Card"), "other");
    }

    #[test]
    fn integrated_graphics_never_unlock_gpu_inference() {
        let igpu = GpuInfo { name: "Intel(R) UHD Graphics 630".into(), vram_mb: 8192, vendor: "intel".into() };
        assert_eq!(usable_vram_mb(&igpu), 0);
        let dgpu = GpuInfo { name: "NVIDIA GeForce RTX 4070".into(), vram_mb: 12288, vendor: "nvidia".into() };
        assert_eq!(usable_vram_mb(&dgpu), 12288);
    }

    #[test]
    fn placeholders_are_ignored() {
        assert!(is_placeholder("Microsoft Basic Display Adapter"));
        assert!(is_placeholder("Microsoft Remote Display Adapter"));
        assert!(!is_placeholder("AMD Radeon Graphics"));
    }
}
