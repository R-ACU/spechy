import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { api } from "../lib/ipc";
import { Button } from "./ui";

export default function UpdateCheck() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.checkForUpdates>> | null>(null);
  const [error, setError] = useState("");

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

  return <section className="help-card">
    <h2 className="help-title">Updates</h2>
    <p className="muted" role="status">{checking ? "Checking for updates..." : error || (result?.available ? `Spechy ${result.version} is available.` : result ? "You are up to date." : "Check for a new version of Spechy.")}</p>
    <p className="muted">Download the installer and run it to update. Your settings and history are kept.</p>
    <div className="help-actions">
      <Button variant="secondary" disabled={checking} onClick={() => void check()}><RefreshCw size={16} />Check for updates</Button>
      <Button variant="secondary" onClick={() => void api.openUrl(result?.downloadUrl || "https://github.com/R-ACU/spechy-releases/releases/latest").catch((reason) => setError(String(reason)))}><Download size={16} />{result?.available ? "Download update" : "Downloads"}</Button>
    </div>
  </section>;
}
