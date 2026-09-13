import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { api } from "../lib/ipc";
import { Button } from "./ui";

export default function UpdateCheck() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.checkForUpdates>> | null>(null);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [ready, setReady] = useState("");
  const [installing, setInstalling] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null } | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await api.updateDownloadStatus();
        if (cancelled) return;
        setDownloading(status.downloading);
        setReady(status.version || "");
        setProgress(status.progress);
        setDownloadError(status.error || "");
      } catch { /* A command failure is reported by the user's update action. */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    setChecking(true);
    void api.checkForUpdates().then((value) => { if (!cancelled) setResult(value); })
      .catch((reason) => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, []);

  const check = async () => {
    setChecking(true);
    setError("");
    try { setResult(await api.checkForUpdates()); }
    catch (reason) { setError(String(reason)); }
    finally { setChecking(false); }
  };

  const download = async () => {
    setDownloading(true);
    setError("");
    setProgress(null);
    try {
      setReady(await api.downloadUpdate(setProgress));
      setInstalling(true);
      await api.installUpdate();
    }
    catch (reason) { setError(String(reason)); }
    finally { setDownloading(false); setInstalling(false); }
  };

  const install = async () => {
    setInstalling(true);
    setError("");
    try { await api.installUpdate(); }
    catch (reason) { setError(String(reason)); setInstalling(false); }
  };

  const percent = progress?.total ? Math.min(100, Math.round(progress.downloaded / progress.total * 100)) : undefined;
  const busy = checking || downloading || installing;

  return <section className="help-card">
    <h2 className="help-title">Updates</h2>
    <p className="muted" role="status">{error || downloadError || (installing ? "Installing update. Spechy will restart..." : downloading ? `Downloading update${percent === undefined ? "..." : `: ${percent}%`}` : ready ? `Spechy ${ready} is ready to install.` : checking ? "Checking for updates..." : result?.available ? `Spechy ${result.version} is available.` : result ? "You are up to date." : "Check for a new version of Spechy.")}</p>
    {downloading && <progress className="update-progress" aria-label="Update download" max={100} value={percent} />}
    <p className="muted">Update now downloads and installs the new version in the background. Spechy briefly closes and restarts. Your settings and history are kept.</p>
    <div className="help-actions">
      <Button variant="secondary" disabled={busy || !isTauri()} onClick={() => void check()}><RefreshCw size={16} />Check for updates</Button>
      {ready ? <Button disabled={busy} onClick={() => void install()}>Update now</Button>
        : result?.available && <Button disabled={busy} onClick={() => void download()}><Download size={16} />{downloading ? "Downloading..." : "Update now"}</Button>}
    </div>
  </section>;
}
