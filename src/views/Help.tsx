import { useEffect, useState } from "react";
import { FolderOpen, RotateCcw } from "lucide-react";
import { api } from "../lib/ipc";
import { t, useStore } from "../lib/store";
import { safe } from "../lib/fallback";
import { Button, Kbd } from "../components/ui";
import UpdateCheck from "../components/UpdateCheck";

function Chord({ chord }: { chord: string }) {
  const parts = chord.split("+").filter(Boolean);
  if (!parts.length) return <span className="faint">not set</span>;
  return (
    <span className="kbd-row">
      {parts.map((p, i) => (
        <span key={p + i} className="kbd-part">
          {i > 0 && <span className="kbd-plus">+</span>}
          <Kbd>{p}</Kbd>
        </span>
      ))}
    </span>
  );
}

export default function Help() {
  const { settings, update } = useStore();
  const lang = settings.appLanguage;
  const [dataDir, setDataDir] = useState("");
  const [version, setVersion] = useState("");

  useEffect(() => {
    void safe(() => api.getDataDir(), "").then(setDataDir);
    void safe(() => api.getAppVersion(), "").then(setVersion);
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t("Help", lang)}</h1>
      </div>

      <div className="help-grid">
        <UpdateCheck />
        <section className="help-card">
          <h2 className="help-title">How to dictate</h2>
          <div className="help-row">
            <Chord chord={settings.hotkeys.pushToTalk} />
            <p className="muted">Hold to talk. Release and Spechy types the text into whatever app has focus.</p>
          </div>
          <div className="help-row">
            <Chord chord={settings.hotkeys.handsFree} />
            <p className="muted">Hands-free: press once to start, press again to stop. Good for long passages.</p>
          </div>
          <div className="help-row">
            <Chord chord={settings.hotkeys.command} />
            <p className="muted">Command mode: select text first, then speak an instruction such as make this shorter.</p>
          </div>
          <p className="muted">Press Escape while recording to cancel without inserting anything.</p>
          <div className="help-row">
            <Chord chord={settings.hotkeys.pasteLast} />
            <p className="muted">Paste your last dictation into the focused app. Change this in Settings, General, Shortcuts.</p>
          </div>
        </section>

        <section className="help-card">
          <h2 className="help-title">Where your data lives</h2>
          <p className="muted">Settings, history, dictionary and snippets are stored on this machine. Cloud providers receive audio for transcription and text for cleanup. Use local custom servers for fully local processing. API keys are stored in your local settings and excluded from data exports.</p>
          <code className="path">{dataDir || "unavailable"}</code>
          <div className="help-actions">
            <Button variant="secondary" onClick={() => { api.openDataDir().catch(() => {}); }}>
              <FolderOpen size={16} />Open data folder
            </Button>
          </div>
        </section>

        <section className="help-card">
          <h2 className="help-title">About</h2>
          <p className="muted">Spechy {version ? `version ${version}` : "version unknown"}</p>
          <p className="muted">Press Ctrl and comma to open settings from anywhere in the app.</p>
          <div className="help-actions">
            <Button variant="secondary" onClick={() => void update({ onboarded: false })}>
              <RotateCcw size={16} />Replay onboarding
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
