import { useState } from "react";
import { X } from "lucide-react";
import { useStore } from "../../lib/store";
import { Toggle } from "../../components/ui";
import { Group, Row } from "./parts";

export default function VibeCoding() {
  const { settings, update } = useStore();
  const [draft, setDraft] = useState("");

  const add = () => {
    const v = draft.trim().toLowerCase();
    if (!v || settings.vibeCodingApps.includes(v)) { setDraft(""); return; }
    void update({ vibeCodingApps: [...settings.vibeCodingApps, v] });
    setDraft("");
  };

  const remove = (v: string) => void update({ vibeCodingApps: settings.vibeCodingApps.filter((a) => a !== v) });

  return (
    <>
      <Group>
        <Row
          label="Vibe coding mode"
          sub="In terminals and code editors Spechy keeps technical terms, file names and commands verbatim and skips prose rewriting."
        >
          <Toggle on={settings.vibeCoding} onChange={(v) => void update({ vibeCoding: v })} />
        </Row>
      </Group>

      <Group label="Extra apps">
        <div className="set-tags">
          <p className="muted set-tags-hint">Process names that should count as coding, next to the built in list.</p>
          <div className="set-chips">
            {settings.vibeCodingApps.map((a) => (
              <span className="set-chip" key={a}>
                {a}
                <button type="button" aria-label={`Remove ${a}`} onClick={() => remove(a)}><X size={13} /></button>
              </span>
            ))}
            {settings.vibeCodingApps.length === 0 && <span className="faint">No extra apps yet.</span>}
          </div>
          <input
            className="input"
            value={draft}
            placeholder="Add a process name, e.g. alacritty"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
            onBlur={add}
          />
        </div>
      </Group>
    </>
  );
}
