// Local model library: curated whisper.cpp models scored against this PC, plus the
// whisper.cpp server itself. Spechy downloads the server build, unpacks it into the
// app data folder and starts it for a downloaded model, so a local setup works
// without hunting for binaries. whisper.cpp is not OpenAI compatible, which is why
// picking a model also switches the custom provider to the whisper.cpp API.
import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Cpu,
  Download,
  ExternalLink,
  FolderOpen,
  HardDrive,
  MemoryStick,
  MonitorSmartphone,
  Play,
  RefreshCw,
  Server,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { api, type HardwareProfile, type LocalFit, type LocalModelFit, type LocalServerStatus } from "../lib/ipc";
import { MOCK, mockHardware, mockLocalModels, mockLocalServer } from "../lib/fallback";
import { useStore } from "../lib/store";
import { Button, Dialog, Listbox } from "./ui";

const WHISPER_RELEASES = "https://github.com/ggerganov/whisper.cpp/releases";
const DEFAULT_PORT = 8178;

/** Server builds the backend knows about. */
const SERVER_FLAVORS: { id: string; label: string; hint: string; size: string }[] = [
  { id: "cuda", label: "CUDA", hint: "NVIDIA GPU, roughly twenty times faster", size: "644 MB" },
  { id: "cpu", label: "CPU", hint: "Runs anywhere, slower", size: "9 MB" },
];

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

/** Reuse the port the provider already points at, so nothing shifts underneath it. */
function portFromUrl(url: string): number {
  const match = url.match(/(?:127\.0\.0\.1|localhost):(\d+)/);
  const value = match ? Number(match[1]) : 0;
  return value >= 1024 && value <= 65535 ? value : DEFAULT_PORT;
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

interface ServerPanelProps {
  status: LocalServerStatus | null;
  model: LocalModelFit | null;
  port: number;
  busy: string;
  progress: { downloaded: number; total: number | null } | null;
  onPort: (port: number) => void;
  onInstall: (flavor: string) => void;
  onStart: () => void;
  onStop: () => void;
}

function ServerPanel({ status, model, port, busy, progress, onPort, onInstall, onStart, onStop }: ServerPanelProps) {
  const installing = busy.startsWith("install:");
  const percent = installing && progress?.total ? Math.round((progress.downloaded / progress.total) * 100) : null;

  let badge = "Checking";
  let badgeClass = "";
  let text = "Looking for whisper.cpp...";
  if (status?.running) {
    badge = "Running";
    badgeClass = "rec";
    text = `${status.modelId ?? "model"} on 127.0.0.1:${status.port} (${status.flavor})`;
  } else if (status?.installed) {
    badge = "Ready";
    badgeClass = "fit-great";
    text = model
      ? `Starts ${model.model.name} on port ${port}.`
      : "Download a model below, then start the server.";
  } else if (status) {
    badge = "Not installed";
    badgeClass = "fit-too_big";
    text = `Runs the models entirely on this PC. Build ${status.build}.`;
  }

  return (
    <div className="mlib-server">
      <div className="mlib-server-top">
        <span className="mlib-server-icon"><Server size={16} /></span>
        <span className="mlib-server-text">
          <span className="mlib-server-title">
            Local server
            <span className={`mlib-badge ${badgeClass}`}>{badge}</span>
          </span>
          <span className="mlib-server-sub">{text}</span>
        </span>

        {status && !status.installed && (
          <span className="mlib-server-actions">
            {SERVER_FLAVORS.map((flavor) => {
              const preferred = status.preferredFlavor === flavor.id;
              return (
                <Button
                  key={flavor.id}
                  variant={preferred ? "primary" : "secondary"}
                  size="sm"
                  disabled={!!busy}
                  title={flavor.hint}
                  onClick={() => onInstall(flavor.id)}
                >
                  {flavor.id === "cuda" ? <Zap size={14} /> : <Cpu size={14} />}
                  {installing && busy === `install:${flavor.id}` ? "Downloading" : `${flavor.label} · ${flavor.size}`}
                </Button>
              );
            })}
          </span>
        )}

        {status?.installed && !status.running && (
          <span className="mlib-server-actions">
            <label className="mlib-port">
              Port
              <input
                className="input"
                type="number"
                min={1024}
                max={65535}
                value={port}
                onChange={(e) => onPort(Number(e.target.value) || DEFAULT_PORT)}
              />
            </label>
            <Button size="sm" disabled={!!busy || !model} onClick={onStart}>
              <Play size={14} /> {busy === "start" ? "Starting" : "Start"}
            </Button>
            {SERVER_FLAVORS.filter((flavor) => !status.installedFlavors.includes(flavor.id)).map((flavor) => (
              <Button key={flavor.id} variant="ghost" size="sm" disabled={!!busy} title={flavor.hint} onClick={() => onInstall(flavor.id)}>
                {installing && busy === `install:${flavor.id}` ? "Downloading" : `+ ${flavor.label}`}
              </Button>
            ))}
          </span>
        )}

        {status?.running && (
          <span className="mlib-server-actions">
            <Button variant="secondary" size="sm" disabled={!!busy} onClick={onStop}>
              <Square size={14} /> {busy === "stop" ? "Stopping" : "Stop"}
            </Button>
          </span>
        )}
      </div>

      {installing && (
        <div className="mlib-progress">
          <div className="progress">
            <div className="progress-fill" style={{ width: percent !== null ? `${percent}%` : "12%" }} />
          </div>
          <span className="faint">
            {progress ? prettyBytes(progress.downloaded) : "0 MB"}
            {progress?.total ? ` of ${prettyBytes(progress.total)}` : ""}
          </span>
        </div>
      )}

      {status && !status.running && status.logTail.length > 0 && (
        <details className="mlib-log">
          <summary>Server log</summary>
          <pre>{status.logTail.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}

interface RowProps {
  fit: LocalModelFit;
  germanFocus: boolean;
  served: boolean;
  progress: { id: string; downloaded: number; total: number | null } | null;
  busy: string;
  onDownload: (id: string) => void;
  onRemove: (id: string) => void;
  onUse: (fit: LocalModelFit) => void;
}

function ModelRow({ fit, germanFocus, served, progress, busy, onDownload, onRemove, onUse }: RowProps) {
  const model = fit.model;
  const downloading = progress?.id === model.id;
  const percent = downloading && progress.total ? Math.round((progress.downloaded / progress.total) * 100) : null;

  return (
    <div className={`mlib-card ${fit.recommended ? "rec" : ""} ${fit.fit === "too_big" ? "dim" : ""}`}>
      <div className="mlib-card-top">
        <div className="mlib-card-title">
          <span className="mlib-name">{model.name}</span>
          <span className="mlib-id">{model.id}</span>
        </div>
        <div className="mlib-badges">
          {served && <span className="mlib-badge rec">Serving</span>}
          {fit.recommended && <span className="mlib-badge ok">Recommended</span>}
          {fit.installed && !served && <span className="mlib-badge">On this PC</span>}
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
            {prettyBytes(progress.downloaded)}
            {progress.total ? ` of ${prettyBytes(progress.total)}` : ""}
          </span>
        </div>
      )}

      <div className="mlib-card-foot">
        <span className="mlib-reason faint">{fit.reason}</span>
        <div className="mlib-actions">
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
          <Button size="sm" disabled={!!busy || !fit.installed} onClick={() => onUse(fit)}>
            <Play size={14} /> Use this model
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ModelLibrary({ onClose, onUse }: { onClose: () => void; onUse: (fit: LocalModelFit, port: number) => void }) {
  const { settings, toast } = useStore();
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [models, setModels] = useState<LocalModelFit[]>([]);
  const [server, setServer] = useState<LocalServerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [onlyFitting, setOnlyFitting] = useState(true);
  const [installedOnly, setInstalledOnly] = useState(false);
  const [sort, setSort] = useState<SortId>("recommended");
  const [progress, setProgress] = useState<{ id: string; downloaded: number; total: number | null } | null>(null);
  const [serverProgress, setServerProgress] = useState<{ downloaded: number; total: number | null } | null>(null);
  const [busy, setBusy] = useState("");
  const [port, setPort] = useState(() => portFromUrl(settings.providers.customSttBaseUrl));

  const germanFocus = settings.dictationLanguages.some((language) => language.toLowerCase().startsWith("de"));

  const load = async () => {
    setLoading(true);
    try {
      const [profile, list, state] = await Promise.all([
        api.localHardware(),
        api.listLocalModels(),
        api.localServerStatus(),
      ]);
      setHardware(profile);
      setModels(list);
      setServer(state);
      setError("");
    } catch (e) {
      if (MOCK) {
        setHardware(mockHardware);
        setModels(mockLocalModels);
        setServer(mockLocalServer);
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
  /** What the Start button in the server panel runs. */
  const startTarget = useMemo(() => {
    const installed = models.filter((entry) => entry.installed);
    return installed.find((entry) => entry.recommended) ?? installed[0] ?? null;
  }, [models]);

  const download = async (id: string) => {
    setBusy(id);
    setProgress({ id, downloaded: 0, total: null });
    try {
      await api.downloadLocalModel(id, (value) => setProgress({ id, ...value }));
      await load();
      toast({ kind: "success", message: "Model downloaded." });
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

  const installServer = async (flavor: string) => {
    setBusy(`install:${flavor}`);
    setServerProgress({ downloaded: 0, total: null });
    try {
      setServer(await api.installLocalServer(flavor, (value) => setServerProgress(value)));
      toast({ kind: "success", message: "Local server ready." });
    } catch (e) {
      toast({ kind: "error", message: String(e) });
    }
    setServerProgress(null);
    setBusy("");
  };

  /** Start the server for a model and point the provider at it. */
  const startServer = async (fit: LocalModelFit | null) => {
    if (!fit) return;
    setBusy("start");
    try {
      const next = await api.startLocalServer(fit.model.id, port);
      setServer(next);
      onUse(fit, next.port);
      toast({ kind: "success", message: `${fit.model.name} is running on port ${next.port}.` });
      setBusy("");
      onClose();
      return;
    } catch (e) {
      toast({ kind: "error", message: String(e) });
      try {
        setServer(await api.localServerStatus());
      } catch {
        /* keep the previous status */
      }
    }
    setBusy("");
  };

  const stopServer = async () => {
    setBusy("stop");
    try {
      setServer(await api.stopLocalServer());
      toast({ kind: "info", message: "Local server stopped." });
    } catch (e) {
      toast({ kind: "error", message: String(e) });
    }
    setBusy("");
  };

  const servedId = server?.running ? server.modelId : null;

  return (
    <Dialog title="Local model library" onClose={onClose} width={780} className="mlib-backdrop">
      <div className="mlib">
        <ServerPanel
          status={server}
          model={startTarget}
          port={port}
          busy={busy}
          progress={serverProgress}
          onPort={setPort}
          onInstall={installServer}
          onStart={() => void startServer(startTarget)}
          onStop={() => void stopServer()}
        />

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
              hint={hardware.vramMb > 0 ? "use the CUDA server build here" : "no dedicated VRAM, use the CPU build"}
            />
          </div>
        )}

        {recommended && recommended.installed && !server?.running && (
          <div className="mlib-rec">
            <span className="mlib-rec-icon"><Sparkles size={16} /></span>
            <span className="mlib-rec-text">
              <span className="mlib-rec-title">Best match: {recommended.model.name}</span>
              <span className="mlib-rec-sub">
                {recommended.reason} · {germanFocus ? `German ${recommended.model.german}/5` : `accuracy ${recommended.model.quality}/5`}
              </span>
            </span>
            <Button size="sm" disabled={!!busy || !recommended.installed} onClick={() => void startServer(recommended)}>
              <Play size={14} /> Use
            </Button>
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
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>
            <RefreshCw size={14} /> Refresh
          </Button>
        </div>

        {loading && <div className="mlib-msg faint">Checking your hardware...</div>}
        {error && <div className="mlib-msg" style={{ color: "var(--danger)" }}>Could not load the library: {error}</div>}
        {!loading && !error && rows.length === 0 && <div className="mlib-msg faint">No model matches these filters.</div>}

        {hardware && rows.map((fit) => (
          <ModelRow
            key={fit.model.id}
            fit={fit}
            germanFocus={germanFocus}
            served={servedId === fit.model.id}
            progress={progress}
            busy={busy}
            onDownload={download}
            onRemove={remove}
            onUse={(entry) => void startServer(entry)}
          />
        ))}

        <div className="mlib-foot faint">
          {server?.installed ? (
            <span>
              <Check size={13} /> Spechy runs whisper.cpp build {server.build} locally and stops it when the app quits.
            </span>
          ) : (
            <span>
              <TriangleAlert size={13} /> Without the local server, downloaded models cannot be used yet. The CPU build is 9 MB.
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={() => void api.openUrl(WHISPER_RELEASES).catch(() => {})}>
            whisper.cpp releases <ExternalLink size={13} />
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
