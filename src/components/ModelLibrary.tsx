// Local model library: curated whisper.cpp models scored against this PC, so people
// can pick one that actually runs instead of guessing from parameter counts.
// Spechy does not run a server itself; a card can copy the whisper.cpp command and
// writes the matching provider settings when the model is used.
import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FolderOpen,
  HardDrive,
  MemoryStick,
  MonitorSmartphone,
  Sparkles,
  Trash2,
} from "lucide-react";
import { api, type HardwareProfile, type LocalFit, type LocalModelFit } from "../lib/ipc";
import { MOCK, mockHardware, mockLocalModels } from "../lib/fallback";
import { useStore } from "../lib/store";
import { Button, Dialog, Listbox } from "./ui";

const WHISPER_RELEASES = "https://github.com/ggerganov/whisper.cpp/releases";

const FIT_LABEL: Record<LocalFit, string> = {
  great: "Runs great",
  good: "Runs well",
  tight: "Just fits",
  too_big: "Too large",
};

type SortId = "recommended" | "german" | "quality" | "speed" | "size";

const SORT_OPTIONS: { value: SortId; label: string }[] = [
  { value: "recommended", label: "Recommended" },
  { value: "german", label: "German quality" },
  { value: "quality", label: "Accuracy" },
  { value: "speed", label: "Speed" },
  { value: "size", label: "Smallest first" },
];

function gb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

/** Exact byte counts in the same unit scale as `gb`. */
function prettyBytes(bytes: number): string {
  return gb(Math.round(bytes / 1_048_576));
}

/** whisper.cpp server command that serves the installed file on a local port. */
export function setupCommand(fit: LocalModelFit, modelsDir: string): string {
  const path = fit.installedPath ?? `${modelsDir}\\${fit.model.file}`;
  return `whisper-server -m "${path}" --host 127.0.0.1 --port 8080 --inference-path /v1/audio/transcriptions`;
}

function Meter({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`mlib-meter ${highlight ? "hl" : ""}`}>
      <span className="mlib-meter-label">{label}</span>
      <span className="mlib-meter-bars" role="img" aria-label={`${label}: ${value} of 5`}>
        {[1, 2, 3, 4, 5].map((step) => <i key={step} className={step <= value ? "on" : ""} />)}
      </span>
    </div>
  );
}

function HardwareStat({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="mlib-hw-item">
      <span className="mlib-hw-icon">{icon}</span>
      <span className="mlib-hw-text">
        <span className="mlib-hw-label">{label}</span>
        <span className="mlib-hw-value" title={value}>{value}</span>
        {hint && <span className="mlib-hw-hint" title={hint}>{hint}</span>}
      </span>
    </div>
  );
}

interface RowProps {
  fit: LocalModelFit;
  modelsDir: string;
  germanFocus: boolean;
  progress: { id: string; downloaded: number; total: number | null } | null;
  busy: string;
  onDownload: (id: string) => void;
  onRemove: (id: string) => void;
  onUse: (fit: LocalModelFit) => void;
}

function ModelRow({ fit, modelsDir, germanFocus, progress, busy, onDownload, onRemove, onUse }: RowProps) {
  const model = fit.model;
  const [copied, setCopied] = useState(false);
  const downloading = progress?.id === model.id;
  const percent = downloading && progress.total ? Math.round((progress.downloaded / progress.total) * 100) : null;

  const copyCommand = async () => {
    try {
      await api.copyToClipboard(setupCommand(fit, modelsDir));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard is unavailable in the browser preview */
    }
  };

  return (
    <div className={`mlib-card ${fit.recommended ? "rec" : ""} ${fit.fit === "too_big" ? "dim" : ""}`}>
      <div className="mlib-card-top">
        <div className="mlib-card-title">
          <span className="mlib-name">{model.name}</span>
          <span className="mlib-id">{model.id}</span>
        </div>
        <div className="mlib-badges">
          {fit.recommended && <span className="mlib-badge rec">Recommended</span>}
          {fit.installed && <span className="mlib-badge ok">On this PC</span>}
          <span className={`mlib-badge fit-${fit.fit}`}>{FIT_LABEL[fit.fit]}</span>
        </div>
      </div>

      <p className="mlib-note">{model.note}</p>

      <div className="mlib-specs">
        <span title="Download size"><HardDrive size={13} /> {prettyBytes(model.sizeBytes)} download</span>
        <span title="Memory the runtime needs"><MemoryStick size={13} /> {gb(model.ramMb)} RAM</span>
        {model.vramMb > 0 && <span title="GPU memory that makes it comfortable"><MonitorSmartphone size={13} /> {gb(model.vramMb)} VRAM</span>}
        <span title="Parameter count"><Cpu size={13} /> {model.params}</span>
        <span title={model.languages}>{model.languages}</span>
      </div>

      <div className="mlib-meters">
        <Meter label="Accuracy" value={model.quality} />
        <Meter label="Speed" value={model.speed} />
        <Meter label="German" value={model.german} highlight={germanFocus} />
      </div>

      {downloading && (
        <div className="mlib-progress">
          <div className="progress">
            <div className="progress-fill" style={{ width: percent !== null ? `${percent}%` : "12%" }} />
          </div>
          <span className="faint">
            {gb(Math.round(progress.downloaded / 1_048_576))}
            {progress.total ? ` of ${gb(Math.round(progress.total / 1_048_576))}` : ""}
          </span>
        </div>
      )}

      <div className="mlib-card-foot">
        <span className="mlib-reason faint">{fit.reason}</span>
        <div className="mlib-actions">
          <Button variant="ghost" size="sm" onClick={() => void copyCommand()} title="Copy the whisper.cpp server command for this model">
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Server command"}
          </Button>
          {fit.installed && (
            <Button variant="ghost" size="sm" disabled={busy === model.id} onClick={() => void onRemove(model.id)} title="Delete the downloaded file">
              <Trash2 size={14} /> Delete
            </Button>
          )}
          {!fit.installed && model.url && (
            <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => void onDownload(model.id)}>
              <Download size={14} /> {downloading ? "Downloading" : "Download"}
            </Button>
          )}
          <Button size="sm" disabled={!fit.installed} onClick={() => onUse(fit)}>Use this model</Button>
        </div>
      </div>
    </div>
  );
}

export function ModelLibrary({ onClose, onUse }: { onClose: () => void; onUse: (fit: LocalModelFit) => void }) {
  const { settings, toast } = useStore();
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [models, setModels] = useState<LocalModelFit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [onlyFitting, setOnlyFitting] = useState(true);
  const [installedOnly, setInstalledOnly] = useState(false);
  const [sort, setSort] = useState<SortId>("recommended");
  const [progress, setProgress] = useState<{ id: string; downloaded: number; total: number | null } | null>(null);
  const [busy, setBusy] = useState("");

  const germanFocus = settings.dictationLanguages.some((language) => language.toLowerCase().startsWith("de"));

  const load = async () => {
    setLoading(true);
    try {
      const [profile, list] = await Promise.all([api.localHardware(), api.listLocalModels()]);
      setHardware(profile);
      setModels(list);
      setError("");
    } catch (e) {
      if (MOCK) {
        setHardware(mockHardware);
        setModels(mockLocalModels);
      } else {
        setError(String(e));
      }
    }
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  // Escape must close the library only, not the settings panel it sits on top of.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let list = models;
    if (needle) {
      list = list.filter((entry) =>
        entry.model.name.toLowerCase().includes(needle)
        || entry.model.id.includes(needle)
        || entry.model.family.toLowerCase().includes(needle));
    }
    if (onlyFitting) list = list.filter((entry) => entry.fit !== "too_big");
    if (installedOnly) list = list.filter((entry) => entry.installed);
    const compare: Record<SortId, (a: LocalModelFit, b: LocalModelFit) => number> = {
      recommended: (a, b) => Number(b.recommended) - Number(a.recommended) || b.score - a.score,
      german: (a, b) => b.model.german - a.model.german || b.model.quality - a.model.quality || b.score - a.score,
      quality: (a, b) => b.model.quality - a.model.quality || b.score - a.score,
      speed: (a, b) => b.model.speed - a.model.speed || b.score - a.score,
      size: (a, b) => a.model.sizeBytes - b.model.sizeBytes,
    };
    return [...list].sort(compare[sort]);
  }, [models, query, onlyFitting, installedOnly, sort]);

  const recommended = useMemo(() => models.find((entry) => entry.recommended) ?? null, [models]);

  const download = async (id: string) => {
    setBusy(id);
    setProgress({ id, downloaded: 0, total: null });
    try {
      await api.downloadLocalModel(id, (value) => setProgress({ id, ...value }));
      await load();
      toast({ kind: "success", message: "Model downloaded. Copy the server command to run it." });
    } catch (e) {
      toast({ kind: "error", message: String(e) });
    }
    setProgress(null);
    setBusy("");
  };

  const remove = async (id: string) => {
    setBusy(id);
    try {
      setModels(await api.removeLocalModel(id));
      toast({ kind: "info", message: "Model file deleted." });
    } catch (e) {
      toast({ kind: "error", message: String(e) });
    }
    setBusy("");
  };

  return (
    <Dialog title="Local model library" onClose={onClose} width={780} className="mlib-backdrop">
      <div className="mlib">
        {hardware && (
          <div className="mlib-hw">
            <HardwareStat
              icon={<Cpu size={14} />}
              label="CPU"
              value={`${hardware.cpuCores} cores`}
              hint={hardware.cpuName || "not detected"}
            />
            <HardwareStat
              icon={<MemoryStick size={14} />}
              label="Memory"
              value={hardware.totalRamMb ? `${gb(hardware.totalRamMb)} · ${gb(hardware.availableRamMb)} free` : "not detected"}
              hint={hardware.totalRamMb ? "RAM limits CPU inference" : "models are not rated against this PC"}
            />
            <HardwareStat
              icon={<MonitorSmartphone size={14} />}
              label="Graphics"
              value={hardware.vramMb > 0 ? `${hardware.gpuName} · ${gb(hardware.vramMb)}` : hardware.gpuName || "CPU only"}
              hint={hardware.vramMb > 0 ? "a GPU makes larger models comfortable" : "no dedicated VRAM, models run on the CPU"}
            />
          </div>
        )}

        {recommended && (
          <div className="mlib-rec">
            <span className="mlib-rec-icon"><Sparkles size={16} /></span>
            <span className="mlib-rec-text">
              <span className="mlib-rec-title">Best match: {recommended.model.name}</span>
              <span className="mlib-rec-sub">
                {recommended.reason} · {germanFocus ? `German ${recommended.model.german}/5` : `accuracy ${recommended.model.quality}/5`}
              </span>
            </span>
            <Button size="sm" disabled={!recommended.installed} onClick={() => onUse(recommended)}>Use</Button>
          </div>
        )}

        <div className="mlib-toolbar">
          <input
            className="input"
            placeholder="Search models"
            aria-label="Search models"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="mlib-check">
            <input type="checkbox" checked={onlyFitting} onChange={(e) => setOnlyFitting(e.target.checked)} />
            Only what runs here
          </label>
          <label className="mlib-check">
            <input type="checkbox" checked={installedOnly} onChange={(e) => setInstalledOnly(e.target.checked)} />
            Installed only
          </label>
          <Listbox value={sort} options={SORT_OPTIONS} onChange={(value) => setSort(value as SortId)} className="mlib-sort" />
        </div>

        <div className="mlib-folder">
          <span className="faint">Models folder</span>
          <code className="set-path" title={hardware?.modelsDir}>{hardware?.modelsDir ?? "..."}</code>
          <Button variant="ghost" size="sm" onClick={() => void api.openModelsDir().catch(() => {})}>
            <FolderOpen size={14} /> Open
          </Button>
        </div>

        {loading && <div className="mlib-msg faint">Checking your hardware...</div>}
        {error && <div className="mlib-msg" style={{ color: "var(--danger)" }}>Could not load the library: {error}</div>}
        {!loading && !error && rows.length === 0 && <div className="mlib-msg faint">No model matches these filters.</div>}

        {hardware && rows.map((fit) => (
          <ModelRow
            key={fit.model.id}
            fit={fit}
            modelsDir={hardware.modelsDir}
            germanFocus={germanFocus}
            progress={progress}
            busy={busy}
            onDownload={download}
            onRemove={remove}
            onUse={onUse}
          />
        ))}

        <div className="mlib-foot faint">
          <span>Spechy does not run a server itself. These files are served by whisper.cpp; point the custom server address at it afterwards.</span>
          <Button variant="ghost" size="sm" onClick={() => void api.openUrl(WHISPER_RELEASES).catch(() => {})}>
            whisper.cpp releases <ExternalLink size={13} />
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
