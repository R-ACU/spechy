import { useEffect, useState } from "react";
import { api, type Hotkeys, type MicDevice } from "../../lib/ipc";
import { safeCall } from "../../lib/mock";
import { useStore } from "../../lib/store";
import { Button, Dialog, Listbox } from "../../components/ui";
import { Chord, ChordRecorder, Group, Row } from "./parts";

const LANG_OPTIONS = [
  { value: "de,en", label: "German + English (auto)" },
  { value: "de", label: "German" },
  { value: "en", label: "English" },
  { value: "", label: "Auto-detect" },
];

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function General() {
  const { settings, update } = useStore();
  const [mics, setMics] = useState<MicDevice[]>([]);
  const [editHotkeys, setEditHotkeys] = useState<Hotkeys | null>(null);

  useEffect(() => { void safeCall(() => api.listMicrophones(), "microphones", []).then(setMics); }, []);

  const micOptions = [
    { value: "", label: "Auto-detect (system default)" },
    ...mics.map((m) => ({ value: m.name, label: m.name, hint: m.isDefault ? "default" : undefined })),
  ];

  const langValue = settings.dictationLanguages.join(",");

  return (
    <>
      <Group>
        <Row
          label="Shortcuts"
          sub={<span className="set-hold">Hold <Chord chord={settings.hotkeys.pushToTalk} /> and speak.</span>}
        >
          <Button variant="secondary" size="sm" onClick={() => setEditHotkeys({ ...settings.hotkeys })}>Change</Button>
        </Row>

        <Row label="Microphone" sub="The device Spechy records from.">
          <Listbox
            value={settings.microphone}
            options={micOptions}
            onChange={(v) => void update({ microphone: v })}
            className="set-listbox"
          />
        </Row>

        <Row label="Dictation languages" sub="What Spechy expects to hear.">
          <Listbox
            value={langValue}
            options={LANG_OPTIONS}
            onChange={(v) => void update({ dictationLanguages: v ? v.split(",") : [] })}
            className="set-listbox"
          />
        </Row>

        <Row label="App language" sub="Language of the Spechy window.">
          <Listbox
            value={settings.appLanguage}
            options={[{ value: "en", label: "English" }, { value: "de", label: "German" }]}
            onChange={(v) => void update({ appLanguage: v as "en" | "de" })}
            className="set-listbox"
          />
        </Row>

        <Row label="Theme" sub="Follow Windows, or force light or dark.">
          <Listbox
            value={settings.theme}
            options={THEME_OPTIONS}
            onChange={(v) => void update({ theme: v as "system" | "light" | "dark" })}
            className="set-listbox"
          />
        </Row>

        <Row label="User name" sub="Used to greet you and to spell your name right.">
          <input
            className="input set-input"
            value={settings.userName}
            placeholder="Your name"
            onChange={(e) => void update({ userName: e.target.value })}
          />
        </Row>
      </Group>

      {editHotkeys && (
        <Dialog title="Change shortcuts" onClose={() => setEditHotkeys(null)}>
          <p className="muted set-dialog-hint">Click a field and press the key combination you want.</p>
          <ChordRecorder label="Push to talk" value={editHotkeys.pushToTalk} onChange={(v) => setEditHotkeys({ ...editHotkeys, pushToTalk: v })} />
          <ChordRecorder label="Hands-free toggle" value={editHotkeys.handsFree} onChange={(v) => setEditHotkeys({ ...editHotkeys, handsFree: v })} />
          <ChordRecorder label="Command mode" value={editHotkeys.command} onChange={(v) => setEditHotkeys({ ...editHotkeys, command: v })} />
          <ChordRecorder label="Paste last dictation" value={editHotkeys.pasteLast} onChange={(v) => setEditHotkeys({ ...editHotkeys, pasteLast: v })} />
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setEditHotkeys(null)}>Cancel</Button>
            <Button onClick={() => { void update({ hotkeys: editHotkeys }); setEditHotkeys(null); }}>Save</Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
