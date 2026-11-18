# Third-party notices

The MIT license covers Spechy's original source code. It does not relicense third-party dependencies, trademarks or assets.

- **Tauri, React, Vite, Rust crates and npm packages:** each dependency retains its own license. Exact dependency versions are recorded in `Cargo.lock` and `package-lock.json`.
- **Lucide:** UI icons are provided by Lucide under the ISC license.
- **Vosk:** Voice Snake downloads the Vosk speech recognition library (alphacep/vosk-api) and, depending on the chosen language, the `vosk-model-small-en-us-0.15` or `vosk-model-small-de-0.15` model on first use. They are licensed under the Apache License 2.0 and are not bundled with the installer.
- **Feedback audio:** `src-tauri/sounds/start.wav`, `stop.wav` and `error.wav` originate from the Wispr Flow default sound theme. These files are excluded from Spechy's MIT license. Their inclusion does not grant rights to the original audio; those rights remain with their respective owners.

Spechy is independently developed and is not affiliated with or endorsed by Wispr Flow or the supported AI providers.
