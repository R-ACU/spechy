import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, Download, LoaderCircle, RefreshCw } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { api, events, DICTATION_RUNNING } from "../lib/ipc";
import { safe } from "../lib/fallback";
import { Button } from "./ui";

type Tone = "neutral" | "busy" | "ok" | "available" | "error";

/** Everything the Updates card shows, derived from the update commands. Kept separate so the card renders from plain data. */
export interface UpdateView {
  tone: Tone;
  title: string;
  detail: string;
  /** 0..100 while downloading, null for an unknown size, undefined when no download runs. */
  progress?: number | null;
  action?: { label: string; primary: boolean; icon?: "refresh" | "download"; onClick: () => void; disabled?: boolean };
  current: string;
}

const ICONS: Record<Tone, ReactNode> = {
  neutral: <RefreshCw size={18} />,
  busy: <LoaderCircle size={18} className="upd-spin" />,
  ok: <CheckCircle2 size={18} />,
  available: <Download size={18} />,
  error: <AlertCircle size={18} />,
};

export function UpdateCard({ view }: { view: UpdateView }) {
  const { tone, title, detail, progress, action, current } = view;
  return <section className="help-card upd" id="spechy-updates" tabIndex={-1}>
    <div className="upd-head">
      <h2 className="help-title">Updates</h2>
      {current && <span className="upd-version">Version {current}</span>}
    </div>
    <div className={`upd-status ${tone}`}>
      <span className="upd-icon" aria-hidden="true">{ICONS[tone]}</span>
      <div className="upd-text" role="status">
        <div className="upd-title">{title}</div>
        <div className="upd-detail">{detail}</div>
        {progress !== undefined && <div className={`progress upd-progress ${progress === null ? "indeterminate" : ""}`}
          role="progressbar" aria-label="Update download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}>
          <div className="progress-fill" style={progress === null ? undefined : { width: `${progress}%` }} />
        </div>}
      </div>
      {action && <Button
        variant={action.primary ? "primary" : "secondary"}
        size="sm"
        className="upd-action"
        disabled={action.disabled}
        onClick={action.onClick}
      >
        {action.icon === "download" && <Download size={15} />}
        {action.icon === "refresh" && <RefreshCw size={14} />}
        {action.label}
      </Button>}
    </div>
    <p className="upd-note">Updates install in the background. Spechy briefly closes and restarts, your settings and history are kept.</p>
  </section>;
}

export default function UpdateCheck() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.checkForUpdates>> | null>(null);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [ready, setReady] = useState("");
  const [installing, setInstalling] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null } | null>(null);
  const [current, setCurrent] = useState("");

  useEffect(() => { void safe(() => api.getAppVersion(), "").then(setCurrent); }, []);

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

  // A running dictation is not an error: the update waits for it and then installs by itself.
  const [waiting, setWaiting] = useState(false);
  const failed = (reason: unknown) => {
    if (String(reason) === DICTATION_RUNNING) setWaiting(true);
    else setError(String(reason));
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
    catch (reason) { failed(reason); }
    finally { setDownloading(false); setInstalling(false); }
  };

  const install = async () => {
    setInstalling(true);
    setError("");
    try { await api.installUpdate(); }
    catch (reason) { failed(reason); setInstalling(false); }
  };
  const installRef = useRef(install);
  installRef.current = install;

  // While waiting: follow the dictation state (event plus a slow poll as a safety net) and
  // install as soon as nothing runs any more. Error counts as done, as in the backend.
  useEffect(() => {
    if (!waiting) return;
    let done = false;
    const onPhase = (phase: string) => {
      if (done || (phase !== "idle" && phase !== "error")) return;
      done = true;
      setWaiting(false);
      void installRef.current();
    };
    let unlisten: (() => void) | undefined;
    void events.onState((s) => onPhase(s.phase)).then((f) => { if (done) f(); else unlisten = f; }).catch(() => {});
    const poll = window.setInterval(() => { void api.getState().then((s) => onPhase(s.phase)).catch(() => {}); }, 1500);
    return () => { done = true; unlisten?.(); window.clearInterval(poll); };
  }, [waiting]);

  const percent = progress?.total ? Math.min(100, Math.round(progress.downloaded / progress.total * 100)) : null;
  const busy = checking || downloading || installing;
  const tauri = isTauri();
  const next = ready || result?.version || "";

  const view: UpdateView = (() => {
    const failure = error || downloadError;
    if (failure) return {
      tone: "error", current,
      title: downloadError && !error ? "The download did not finish" : "Something went wrong",
      detail: failure,
      action: ready ? { label: "Update now", primary: true, onClick: () => void install(), disabled: busy }
        : result?.available ? { label: "Try again", primary: true, icon: "download", onClick: () => void download(), disabled: busy }
        : { label: "Try again", primary: false, icon: "refresh", onClick: () => void check(), disabled: busy || !tauri },
    };
    if (waiting) return {
      tone: "busy", current, title: `Spechy ${next} installs after your dictation`,
      detail: "Finish your dictation first, then the update installs and Spechy restarts.",
      action: { label: "Not now", primary: false, onClick: () => setWaiting(false) },
    };
    if (installing) return { tone: "busy", current, title: `Installing Spechy ${next}`, detail: "Spechy closes and restarts in a moment." };
    if (downloading) return {
      tone: "busy", current, progress: percent,
      title: `Downloading Spechy ${next}`,
      detail: percent === null ? "Starting the download..." : `${percent}% downloaded`,
    };
    if (ready) return {
      tone: "available", current, title: `Spechy ${ready} is ready`,
      detail: "Downloaded and verified. Install it now to restart into the new version.",
      action: { label: "Update now", primary: true, icon: "download", onClick: () => void install(), disabled: busy },
    };
    if (checking) return { tone: "busy", current, title: "Checking for updates", detail: "This takes a few seconds." };
    if (result?.available) return {
      tone: "available", current, title: `Spechy ${result.version} is available`,
      detail: current ? `You have version ${current}.` : "A new version is ready to download.",
      action: { label: "Update now", primary: true, icon: "download", onClick: () => void download(), disabled: busy },
    };
    if (result) return {
      tone: "ok", current, title: "You are up to date",
      detail: current ? `Spechy ${current} is the latest version.` : "You have the latest version.",
      action: { label: "Check again", primary: false, icon: "refresh", onClick: () => void check(), disabled: busy || !tauri },
    };
    return {
      tone: "neutral", current, title: "Check for a new version",
      detail: tauri ? "Spechy looks for updates when the window opens." : "Updates are only available in the desktop app.",
      action: { label: "Check now", primary: false, icon: "refresh", onClick: () => void check(), disabled: busy || !tauri },
    };
  })();

  return <UpdateCard view={view} />;
}
