import { AudioLines, BarChart3, BookMarked, CircleHelp, LayoutGrid, NotebookPen, Scissors, Settings, Type, WandSparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { t, useStore } from "../lib/store";

const main: { id: string; label: string; Icon: LucideIcon }[] = [
  { id: "home", label: "Home", Icon: LayoutGrid },
  { id: "insights", label: "Insights", Icon: BarChart3 },
  { id: "dictionary", label: "Dictionary", Icon: BookMarked },
  { id: "snippets", label: "Snippets", Icon: Scissors },
  { id: "style", label: "Style", Icon: Type },
  { id: "transforms", label: "Transforms", Icon: WandSparkles },
  { id: "scratchpad", label: "Scratchpad", Icon: NotebookPen },
];

const bottom: { id: string; label: string; Icon: LucideIcon }[] = [
  { id: "settings", label: "Settings", Icon: Settings },
  { id: "help", label: "Help", Icon: CircleHelp },
];

export default function Sidebar({ collapsed, activeId }: { collapsed: boolean; activeId: string }) {
  const { navigate, settings } = useStore();
  const lang = settings.appLanguage;

  const item = ({ id, label, Icon }: { id: string; label: string; Icon: LucideIcon }) => (
    <button
      key={id}
      className={`nav-item ${activeId === id ? "active" : ""}`}
      onClick={() => navigate(id)}
      title={collapsed ? t(label, lang) : undefined}
      aria-current={activeId === id ? "page" : undefined}
    >
      <Icon size={19} strokeWidth={1.8} />
      <span className="nav-label">{t(label, lang)}</span>
    </button>
  );

  return (
    <nav className={`sidebar ${collapsed ? "collapsed" : ""}`} aria-label="Main">
      <div className="brand">
        <AudioLines size={24} strokeWidth={2.2} />
        <span className="brand-name">Spechy</span>
      </div>
      <div className="nav-group">{main.map(item)}</div>
      <div className="nav-spacer" />
      <div className="nav-divider" />
      <div className="nav-group">{bottom.map(item)}</div>
    </nav>
  );
}
