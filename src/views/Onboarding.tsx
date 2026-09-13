// First run flow. Rendered full screen by App.tsx while settings.onboarded is false.
// Structure follows Wispr Flow's own onboarding (see _dev/wispr-onboarding.md), copy is our own.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  BookMarked,
  Check,
  CircleCheck,
  ExternalLink,
  Keyboard,
  KeyRound,
  Mic,
  Pencil,
  Plus,
  Sparkles,
} from "lucide-react";
import { api, events, type DictationState, type HistoryEntry, type MicDevice } from "../lib/ipc";
import { useStore } from "../lib/store";
import { MOCK, mockMicrophones, safe } from "../lib/fallback";
import { Button, Dialog, Kbd, Listbox, Toggle } from "../components/ui";
import { ChordRecorder, SecretInput } from "./settings/parts";

const STEPS = ["welcome", "keys", "microphone", "hotkey", "practice", "dictionary", "done"] as const;
type StepId = (typeof STEPS)[number];

const SUGGESTED_WORDS = ["Spechy", "TypeScript", "GitHub"];
const PRACTICE_HINT = "Hold Ctrl + Win and say: Hi Anna, thanks for the update, I will send the files tomorrow.";

/** Renders "Ctrl+Win+Space" as separate key caps. */
function Chord({ chord }: { chord: string }) {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return <span className="faint">not set</span>;
  return (
    <span className="onb-chord">
      {parts.map((p, i) => (
        <span key={`${p}-${i}`} className="onb-chord-part">
          {i > 0 && <span className="onb-chord-plus">+</span>}
          <Kbd>{p}</Kbd>
        </span>
      ))}
    </span>
  );
}

function StepHead({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="onb-head">
      <div className="onb-icon">{icon}</div>
      <h1 className="onb-title">{title}</h1>
      <p className="onb-body">{body}</p>
    </div>
  );
}

export default function Onboarding() {
  const { settings, update, toast } = useStore();
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<"fwd" | "back">("fwd");
  const step: StepId = STEPS[index];

  // step 2: provider keys
  const providers = settings.providers;
  const [testing, setTesting] = useState<"groq" | "openrouter" | null>(null);
  const [passed, setPassed] = useState<{ groq: boolean; openrouter: boolean }>({ groq: false, openrouter: false });

  // step 3: microphone
  const [mics, setMics] = useState<MicDevice[]>([]);
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(false);

  // step 4: hotkeys
  const [recording, setRecording] = useState<null | keyof typeof settings.hotkeys>(null);
  const [draftChord, setDraftChord] = useState("");

  // step 5: practice
  const [practice, setPractice] = useState("");
  const [lastEntry, setLastEntry] = useState<HistoryEntry | null>(null);
  const practiceRef = useRef<HTMLTextAreaElement>(null);
  const [snippetValue, setSnippetValue] = useState("");
  const [snippetSaved, setSnippetSaved] = useState(false);
  const [snippetTry, setSnippetTry] = useState("");

  // step 6: dictionary
  const [word, setWord] = useState("");
  const [added, setAdded] = useState<string[]>([]);

  const go = useCallback((delta: number) => {
    setDirection(delta > 0 ? "fwd" : "back");
    setIndex((i) => Math.min(STEPS.length - 1, Math.max(0, i + delta)));
  }, []);

  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    events
      .onState((s: DictationState) => {
        setLevel(s.level);
        if (s.level > 0.04) setHeard(true);
      })
      .then((f) => { if (dead) f(); else un = f; })
      .catch(() => {});
    return () => { dead = true; un?.(); };
  }, []);

  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    events
      .onHistoryAdded((h) => setLastEntry(h))
      .then((f) => { if (dead) f(); else un = f; })
      .catch(() => {});
    return () => { dead = true; un?.(); };
  }, []);

  useEffect(() => {
    if (step !== "microphone") return;
    void safe(() => api.listMicrophones(), MOCK ? mockMicrophones : []).then(setMics);
  }, [step]);

  useEffect(() => {
    if (step === "practice") practiceRef.current?.focus();
  }, [step]);

  const hasKey = providers.groqApiKey.trim().length > 0 || providers.openrouterApiKey.trim().length > 0;
  const canContinue = step !== "keys" || hasKey;

  const patchProviders = (next: Partial<typeof providers>) => void update({ providers: { ...providers, ...next } });

  const test = async (provider: "groq" | "openrouter", key: string) => {
    if (!key.trim()) { toast({ kind: "error", message: "Enter an API key first" }); return; }
    setTesting(provider);
    try {
      const msg = await api.testProvider(provider, key);
      setPassed((p) => ({ ...p, [provider]: true }));
      toast({ kind: "success", message: msg });
    } catch (e) {
      setPassed((p) => ({ ...p, [provider]: false }));
      toast({ kind: "error", message: String(e) });
    }
    setTesting(null);
  };

  const addWord = async (value: string) => {
    const w = value.trim();
    if (!w || added.includes(w)) return;
    await api.addDictionary(w, "").catch(() => {});
    setAdded((l) => [...l, w]);
    setWord("");
  };

  const saveSnippet = async () => {
    const value = snippetValue.trim();
    if (!value) { toast({ kind: "error", message: "Type the text the snippet should insert" }); return; }
    await api.addSnippet("my email address", value).catch(() => {});
    setSnippetSaved(true);
  };

  const customWords = useMemo(() => added.filter((w) => !SUGGESTED_WORDS.includes(w)), [added]);
  const practiceWords = useMemo(() => practice.trim().split(/\s+/).filter(Boolean).length, [practice]);

  const finish = async () => {
    await update({ onboarded: true });
  };

  const content = (() => {
    switch (step) {
      case "welcome":
        return (
          <>
            <div className="onb-head">
              <div className="onb-wordmark">
                <AudioLines size={34} strokeWidth={1.6} />
                <span>Spechy</span>
              </div>
              <p className="onb-body onb-lead">Speak into any app on this machine and get clean, punctuated text back in about a second.</p>
            </div>
            <ul className="onb-list">
              <li><Mic size={16} />Hold one chord, talk, release. The text lands where your cursor is.</li>
              <li><Sparkles size={16} />Fillers, stutters and stray punctuation are cleaned up for you.</li>
              <li><KeyRound size={16} />Everything stays on this machine: no account, no server of ours.</li>
            </ul>
          </>
        );

      case "keys":
        return (
          <>
            <StepHead
              icon={<KeyRound size={22} strokeWidth={1.8} />}
              title="Connect a provider"
              body="Spechy uses your own API keys, so nothing runs through us. One key is enough to get going."
            />
            <div className="onb-fields">
              <div className="onb-field">
                <div className="onb-field-head">
                  <div>
                    <span className="onb-field-label">Groq {passed.groq && <Check size={14} className="onb-ok" />}</span>
                    <span className="onb-field-sub">Transcription. The free tier needs no credit card, just a key.</span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => void api.openUrl("https://console.groq.com/keys").catch(() => {})}>
                    Get a key<ExternalLink size={14} />
                  </Button>
                </div>
                <div className="onb-key">
                  <SecretInput value={providers.groqApiKey} onChange={(v) => { setPassed((p) => ({ ...p, groq: false })); patchProviders({ groqApiKey: v }); }} placeholder="gsk_..." />
                  <Button variant="secondary" size="sm" disabled={testing === "groq"} onClick={() => void test("groq", providers.groqApiKey)}>
                    {testing === "groq" ? "Testing" : "Test"}
                  </Button>
                </div>
              </div>

              <div className="onb-field">
                <div className="onb-field-head">
                  <div>
                    <span className="onb-field-label">OpenRouter {passed.openrouter && <Check size={14} className="onb-ok" />}</span>
                    <span className="onb-field-sub">Cleans up the transcript and stands in if Groq is down. Pay as you go, cents per month.</span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => void api.openUrl("https://openrouter.ai/settings/keys").catch(() => {})}>
                    Get a key<ExternalLink size={14} />
                  </Button>
                </div>
                <div className="onb-key">
                  <SecretInput value={providers.openrouterApiKey} onChange={(v) => { setPassed((p) => ({ ...p, openrouter: false })); patchProviders({ openrouterApiKey: v }); }} placeholder="sk-or-..." />
                  <Button variant="secondary" size="sm" disabled={testing === "openrouter"} onClick={() => void test("openrouter", providers.openrouterApiKey)}>
                    {testing === "openrouter" ? "Testing" : "Test"}
                  </Button>
                </div>
              </div>
            </div>
            {!hasKey && <p className="onb-note faint">Add at least one key to continue. You can change both later in Settings.</p>}
            <p className="onb-note faint">You can connect local or custom models later under Settings, Providers.</p>
          </>
        );

      case "microphone":
        return (
          <>
            <StepHead
              icon={<Mic size={22} strokeWidth={1.8} />}
              title="Pick your microphone"
              body="Choose the input Spechy should listen to, then hold your dictation hotkey once so you can see the level move."
            />
            <div className="onb-fields">
              <div className="onb-field">
                <span className="onb-field-label">Input device</span>
                <Listbox
                  value={settings.microphone}
                  options={[
                    { value: "", label: "System default" },
                    ...mics.map((m) => ({ value: m.name, label: m.name, hint: m.isDefault ? "default" : undefined })),
                  ]}
                  onChange={(v) => void update({ microphone: v })}
                  placeholder="System default"
                />
              </div>

              <div className="onb-field">
                <span className="onb-field-label">Input level</span>
                <div className="onb-meter" role="meter" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Microphone level">
                  <div className="onb-meter-fill" style={{ width: `${Math.min(100, Math.round(level * 130))}%` }} />
                </div>
                <p className="onb-field-sub">
                  Hold <Chord chord={settings.hotkeys.pushToTalk} /> and say a few words.
                  {heard ? <span className="onb-ok-line"><Check size={14} />Spechy can hear you.</span> : " The bar fills while you speak."}
                </p>
              </div>
            </div>
          </>
        );

      case "hotkey":
        return (
          <>
            <StepHead
              icon={<Keyboard size={22} strokeWidth={1.8} />}
              title="Your dictation chords"
              body="These work in every app, even when the Spechy window is closed. Keep them or pick your own."
            />
            <div className="onb-chords">
              {([
                { key: "pushToTalk" as const, label: "Push to talk", hint: "Hold, speak, release." },
                { key: "handsFree" as const, label: "Hands free", hint: "Press once to start, again to stop." },
                { key: "command" as const, label: "Command mode", hint: "Select text, then speak an instruction." },
              ]).map((row) => (
                <div key={row.key} className="onb-chord-row">
                  <div className="onb-chord-text">
                    <span className="onb-field-label">{row.label}</span>
                    <span className="onb-field-sub">{row.hint}</span>
                  </div>
                  <Chord chord={settings.hotkeys[row.key]} />
                  <Button variant="secondary" size="sm" onClick={() => { setDraftChord(settings.hotkeys[row.key]); setRecording(row.key); }}>
                    <Pencil size={14} />Change
                  </Button>
                </div>
              ))}
            </div>
            <p className="onb-note faint">Press Escape while recording to cancel a dictation without inserting anything.</p>
          </>
        );

      case "practice":
        return (
          <>
            <StepHead
              icon={<Sparkles size={22} strokeWidth={1.8} />}
              title="Try it: write a short email"
              body="Click into the box below so it has focus, then hold your hotkey and speak. Spechy types the finished text right into it."
            />
            <div className="onb-fields">
              <div className="onb-field">
                <textarea
                  ref={practiceRef}
                  className="input onb-textarea"
                  value={practice}
                  placeholder={PRACTICE_HINT}
                  onChange={(e) => setPractice(e.target.value)}
                />
                {practice.trim().length > 0 && (
                  <p className="onb-ok-line">
                    <Check size={14} />
                    {practiceWords} {practiceWords === 1 ? "word" : "words"} without touching the keyboard
                    {lastEntry ? `, ready in ${(lastEntry.latencyMs / 1000).toFixed(1)} seconds.` : "."}
                  </p>
                )}
              </div>

              <div className="onb-field onb-sub-exercise">
                <span className="onb-field-label">Now try a snippet</span>
                <span className="onb-field-sub">
                  A snippet turns a phrase you say into text you never want to spell out. Type what
                  <span className="onb-quote">my email address</span>
                  should insert, then dictate that phrase into the box above.
                </span>
                <div className="onb-key">
                  <input
                    className="input"
                    value={snippetValue}
                    placeholder="you@example.com"
                    spellCheck={false}
                    onChange={(e) => { setSnippetValue(e.target.value); setSnippetSaved(false); }}
                  />
                  <Button variant="secondary" size="sm" onClick={() => void saveSnippet()}>
                    {snippetSaved ? "Saved" : "Save"}
                  </Button>
                </div>
                {snippetSaved && (
                  <>
                    <p className="onb-ok-line"><Check size={14} />Snippet saved. Say <span className="onb-quote">my email address</span> and Spechy writes it out.</p>
                    <input
                      className="input"
                      value={snippetTry}
                      placeholder="Dictate here: my email address"
                      onChange={(e) => setSnippetTry(e.target.value)}
                    />
                  </>
                )}
              </div>
            </div>
          </>
        );

      case "dictionary":
        return (
          <>
            <StepHead
              icon={<BookMarked size={22} strokeWidth={1.8} />}
              title="Teach it your words"
              body="Names, products and jargon that no transcriber gets right on the first try. Add three you say often."
            />
            <div className="onb-fields">
              <div className="onb-field">
                <div className="onb-key">
                  <input
                    className="input"
                    value={word}
                    placeholder="Add a word or a name"
                    spellCheck={false}
                    onChange={(e) => setWord(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addWord(word); } }}
                  />
                  <Button variant="secondary" size="sm" onClick={() => void addWord(word)}><Plus size={14} />Add</Button>
                </div>
                <span className="onb-field-sub">Suggestions</span>
                <div className="onb-chips">
                  {SUGGESTED_WORDS.map((w) => (
                    <button key={w} type="button" className={`onb-chip ${added.includes(w) ? "added" : ""}`} onClick={() => void addWord(w)}>
                      {added.includes(w) ? <Check size={13} /> : <Plus size={13} />}{w}
                    </button>
                  ))}
                </div>
              </div>

              {customWords.length > 0 && (
                <div className="onb-field">
                  <span className="onb-field-label">Added by you</span>
                  <div className="onb-chips">
                    {customWords.map((w) => <span key={w} className="onb-chip added"><Check size={13} />{w}</span>)}
                  </div>
                </div>
              )}

              <p className="onb-note faint">
                {added.length === 0 ? "Nothing added yet. Three is a good start, you can add more any time." : `${added.length} added. You can add more from the Dictionary view later.`}
              </p>
            </div>
          </>
        );

      case "done":
        return (
          <>
            <StepHead
              icon={<CircleCheck size={22} strokeWidth={1.8} />}
              title="You are set up"
              body="Spechy sits in the tray and listens for your chord. Close the window whenever you like, dictation keeps working."
            />
            <div className="onb-summary">
              <div className="onb-summary-row"><Chord chord={settings.hotkeys.pushToTalk} /><span>Hold to talk</span></div>
              <div className="onb-summary-row"><Chord chord={settings.hotkeys.handsFree} /><span>Hands free, press twice</span></div>
              <div className="onb-summary-row"><Chord chord={settings.hotkeys.command} /><span>Command mode on selected text</span></div>
            </div>
            <div className="onb-launch">
              <div className="onb-launch-text">
                <span className="onb-field-label">Launch at login</span>
                <span className="onb-field-sub">Start Spechy with Windows so the hotkey is always live.</span>
              </div>
              <Toggle on={settings.launchAtLogin} onChange={(v) => void update({ launchAtLogin: v })} />
            </div>
          </>
        );
    }
  })();

  return (
    <div className="onb">
      <div className="onb-card">
        <div key={step} className={`onb-step onb-${direction}`}>{content}</div>

        <div className="onb-foot">
          <div className="onb-foot-left">
            {index > 0 && (
              <Button variant="ghost" onClick={() => go(-1)}><ArrowLeft size={16} />Back</Button>
            )}
          </div>

          <div className="onb-dots" role="progressbar" aria-valuenow={index + 1} aria-valuemin={1} aria-valuemax={STEPS.length} aria-label="Onboarding progress">
            {STEPS.map((s, i) => (
              <span key={s} className={`onb-dot ${i === index ? "active" : ""} ${i < index ? "done" : ""}`} />
            ))}
          </div>

          <div className="onb-foot-right">
            {step === "done" ? (
              <Button onClick={() => void finish()}>Open Spechy<ArrowRight size={16} /></Button>
            ) : (
              <Button disabled={!canContinue} onClick={() => go(1)}>Continue<ArrowRight size={16} /></Button>
            )}
          </div>
        </div>
      </div>

      {recording && (
        <Dialog title="Record a new chord" onClose={() => setRecording(null)} width={360}>
          <ChordRecorder label="Press the keys you want to use" value={draftChord} onChange={setDraftChord} />
          <div className="dialog-actions">
            <Button variant="secondary" onClick={() => setRecording(null)}>Cancel</Button>
            <Button
              onClick={() => {
                if (draftChord) void update({ hotkeys: { ...settings.hotkeys, [recording]: draftChord } });
                setRecording(null);
              }}
            >
              Save
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
