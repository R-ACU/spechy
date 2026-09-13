import { useEffect, useState } from "react";
import { api } from "../../lib/ipc";
import { safeCall } from "../../lib/mock";
import { useStore } from "../../lib/store";
import { Button, Dialog } from "../../components/ui";
import { Group, Row } from "./parts";

export default function DataPrivacy() {
  const { toast } = useStore();
  const [dir, setDir] = useState("");
  const [confirm, setConfirm] = useState(false);

  useEffect(() => { void safeCall(() => api.getDataDir(), "dataDir", "").then(setDir); }, []);

  const exportData = async () => {
    try { const path = await api.exportData(); toast({ kind: "success", message: `Exported to ${path}` }); }
    catch { toast({ kind: "error", message: "Export failed" }); }
  };

  const clear = async () => {
    try { await api.clearHistory(); toast({ kind: "success", message: "History cleared" }); }
    catch { toast({ kind: "error", message: "Could not clear the history" }); }
    setConfirm(false);
  };

  return (
    <>
      <Group>
        <Row
          label="Local storage, your choice of provider"
          sub={<>Cloud providers receive audio for transcription and text for cleanup. Release builds do not save raw recordings. History, dictionary and snippets live in <code className="set-path">{dir || "the app data folder"}</code>.</>}
        >
          <Button variant="secondary" size="sm" onClick={() => void api.openDataDir().catch(() => {})}>Open folder</Button>
        </Row>
        <Row label="Export data" sub="Writes a JSON file with history, dictionary, snippets and settings. API keys are excluded.">
          <Button variant="secondary" size="sm" onClick={() => void exportData()}>Export data</Button>
        </Row>
        <Row label="Clear history" sub="Removes every dictation from this machine. Cannot be undone.">
          <Button variant="danger" size="sm" onClick={() => setConfirm(true)}>Clear history</Button>
        </Row>
      </Group>

      {confirm && (
        <Dialog title="Clear history" onClose={() => setConfirm(false)} width={420}>
          <p className="muted">Every dictation will be deleted from this machine. This cannot be undone.</p>
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => void clear()}>Clear history</Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
