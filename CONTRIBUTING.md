# Contributing to Spechy

Thanks for helping improve voice dictation on Windows.

## Report a bug

Open a GitHub issue with:

- Spechy version and Windows version.
- What you expected and what happened.
- Steps to reproduce, including the target app and shortcut if relevant.
- Microphone and provider/model names for audio problems.

Remove API keys and private dictation text from logs and screenshots. Never upload your `settings.json` file: it contains provider credentials.

## Make a change

1. Fork the repository and create a focused branch.
2. Run `npm ci`, then `npm run tauri dev` on Windows.
3. Implement one coherent change. Keep Rust command types and `src/lib/ipc.ts` in sync.
4. Run the checks below, and include a screenshot for interface changes.
5. Open a pull request describing the behavior, your change and its validation.

```powershell
npx tsc --noEmit -p .
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
npm run build
```

Keep keyboard-hook callbacks fast; move slow work to worker threads. Use the existing theme tokens and Lucide icons. Never commit provider credentials, raw recordings, personal histories or build output.

The source code is MIT-licensed. Contribute only code and assets you have permission to share; third-party material retains its own license.
