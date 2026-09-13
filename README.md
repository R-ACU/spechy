# Spechy

Voice dictation for Windows. Hold Ctrl+Win, speak, release: clean text lands where you were typing.

## Download and setup

[Download Spechy for Windows](https://github.com/R-ACU/spechy-releases/releases/latest/download/Spechy-Setup.exe)

Windows 10/11, x64. Run the installer, then follow onboarding to select your microphone and add your own provider API key. Groq handles transcription; cleanup can use Groq, OpenRouter or a custom OpenAI-compatible server. No Spechy account is required. Provider usage may incur costs under your own account.

This initial release is not Windows code-signed, so Windows may show an unknown-publisher warning.

## Shortcuts

| Action | Default |
| --- | --- |
| Hold to dictate | Ctrl+Win |
| Toggle hands-free dictation | Ctrl+Win+Space |
| Voice command for selected text | Ctrl+Win+Shift |
| Paste the last dictation | Shift+Alt+Z |
| Cancel recording | Escape |

Change shortcuts in **Settings > General > Shortcuts**. Paste last dictation uses the latest saved history entry, including after restarting Spechy. It is inactive while a dictation is running. Dictation into elevated administrator windows may be blocked by Windows.

## Updates

Open **Help > Updates** to check and download a new version. Run the downloaded installer to update; settings and history remain in place. Installation is manual, not silent. The download link above always points to the latest published installer and can be used on a website.

## Features

History, insights, dictionary, snippets, per-app style rules, transforms, scratchpad, live transcript and a native recording pill. Light and dark themes. Bring your own models through Groq, OpenRouter or custom OpenAI-compatible transcription and chat endpoints.

## Data

Settings and history are stored in `%APPDATA%\com.remo.spechy`. API keys are stored in local settings, are never bundled with the app and are excluded from data exports. Cloud transcription sends audio to your selected provider; cleanup sends text. Fully local processing requires configuring local custom servers for both steps. Release builds do not save raw microphone recordings. Update checks contact GitHub.

## Development

Requires Windows, Node.js, Rust and the Microsoft C++ build tools.

```powershell
npm ci
npm run tauri dev
npx tsc --noEmit -p .
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri build
```

Installer: `src-tauri/target/release/bundle/nsis/`.

## Publish an update

1. Set the same version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`; refresh both lockfiles.
2. Commit the changes and write English release notes to a file outside the tracked source tree.
3. Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -NotesFile <path>`.

The release script checks versions and a clean working tree, runs the checks, builds the installer, pushes the source and version tag, and publishes the installer plus SHA-256 checksum to the public download repository. It uses your local GitHub CLI login; no token is shipped in the app or stored in the repository.
