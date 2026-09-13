//! Public release discovery. Downloads open in the browser; installation is explicit.
use serde::{Deserialize, Serialize};

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
    fn compares_versions_numerically_and_rejects_invalid_releases() {
        assert!(version_parts("v0.10.0").unwrap() > version_parts("0.9.0").unwrap());
        assert_eq!(version_parts("v0.1.0").unwrap(), version_parts("0.1.0").unwrap());
        assert!(version_parts("1.0").is_err());
        assert!(version_parts("1.0.0-beta").is_err());
    }
}
