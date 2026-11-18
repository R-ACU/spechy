import { lazy, Suspense, useEffect, useState } from "react";
import { Code, Hash, Laptop, Palette, Plug, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { api } from "../../lib/ipc";
import { safeCall } from "../../lib/mock";
import General from "./General";
import SystemSection from "./System";
import Providers from "./Providers";
import VibeCoding from "./VibeCoding";
import DataPrivacy from "./DataPrivacy";
import Themes from "./Themes";

/** Developer tools (Games economy). Dev builds only: the import is dropped from release bundles. */
const Developer = import.meta.env.DEV ? lazy(() => import("./Developer")) : null;

type SectionId = "general" | "themes" | "system" | "providers" | "vibe" | "data" | "developer";

const SECTIONS: { id: SectionId; label: string; icon: React.ReactNode; group: "settings" | "data" | "dev" }[] = [
  { id: "general", label: "General", icon: <SlidersHorizontal size={17} />, group: "settings" },
  { id: "themes", label: "Themes", icon: <Palette size={17} />, group: "settings" },
  { id: "system", label: "System", icon: <Laptop size={17} />, group: "settings" },
  { id: "providers", label: "Providers", icon: <Plug size={17} />, group: "settings" },
  { id: "vibe", label: "Vibe coding", icon: <Hash size={17} />, group: "settings" },
  { id: "data", label: "Data and Privacy", icon: <ShieldCheck size={17} />, group: "data" },
  ...(Developer ? [{ id: "developer" as const, label: "Developer", icon: <Code size={17} />, group: "dev" as const }] : []),
];

const TITLES: Record<SectionId, string> = {
  general: "General",
  themes: "Themes",
  system: "System",
  providers: "Providers",
  vibe: "Vibe coding",
  data: "Data and Privacy",
  developer: "Developer",
};

function isSection(v: string | undefined): v is SectionId {
  return !!v && SECTIONS.some((s) => s.id === v);
}

export default function Settings({ open, onClose, initialSection }: { open: boolean; onClose: () => void; initialSection?: string }) {
  const [section, setSection] = useState<SectionId>(isSection(initialSection) ? initialSection : "general");
  const [version, setVersion] = useState("0.1.0");

  useEffect(() => { if (open && isSection(initialSection)) setSection(initialSection); }, [open, initialSection]);

  useEffect(() => {
    if (!open) return;
    void safeCall(() => api.getAppVersion(), "appVersion", "0.1.0").then(setVersion);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="set-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="set-panel" role="dialog" aria-modal="true" aria-label="Settings">
        <nav className="set-nav">
          <div className="set-nav-scroll">
            <div className="section-label set-nav-label">Settings</div>
            {SECTIONS.filter((s) => s.group === "settings").map((s) => (
              <button
                key={s.id}
                type="button"
                className={`set-nav-item ${section === s.id ? "active" : ""}`}
                onClick={() => setSection(s.id)}
              >
                {s.icon}
                <span>{s.label}</span>
              </button>
            ))}
            <div className="section-label set-nav-label set-nav-label-2">Data</div>
            {SECTIONS.filter((s) => s.group === "data").map((s) => (
              <button
                key={s.id}
                type="button"
                className={`set-nav-item ${section === s.id ? "active" : ""}`}
                onClick={() => setSection(s.id)}
              >
                {s.icon}
                <span>{s.label}</span>
              </button>
            ))}
            {Developer && (
              <>
                <div className="section-label set-nav-label set-nav-label-2">Development</div>
                {SECTIONS.filter((s) => s.group === "dev").map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`set-nav-item ${section === s.id ? "active" : ""}`}
                    onClick={() => setSection(s.id)}
                  >
                    {s.icon}
                    <span>{s.label}</span>
                  </button>
                ))}
              </>
            )}
          </div>
          <div className="set-nav-foot faint">Spechy v{version}</div>
        </nav>

        <div className="set-body">
          <h2 className="set-title">{TITLES[section]}</h2>
          <div className="set-sections" key={section}>
            {section === "general" && <General />}
            {section === "themes" && <Themes />}
            {section === "system" && <SystemSection />}
            {section === "providers" && <Providers />}
            {section === "vibe" && <VibeCoding />}
            {section === "data" && <DataPrivacy />}
            {section === "developer" && Developer && <Suspense fallback={null}><Developer /></Suspense>}
          </div>
        </div>
      </div>
    </div>
  );
}
