// Provider settings: pick where transcription and cleanup run, including your own
// or a local OpenAI-compatible server. Everything saves the moment it changes.
import { useEffect, useState } from "react";
import { ExternalLink, Library } from "lucide-react";
import { api, type LocalModelFit, type LocalServerStatus, type ModelSource, type PolishProvider, type Providers as ProvidersModel, type SttProvider } from "../../lib/ipc";
import { safeCall } from "../../lib/mock";
import { useStore } from "../../lib/store";
import { Button, Toggle } from "../../components/ui";
import { ModelPicker, type Recommendation } from "../../components/ModelPicker";
import { ModelLibrary } from "../../components/ModelLibrary";
import { Choice, Group, Row, SecretInput, type ChoiceOption } from "./parts";

const STT_CHOICES: ChoiceOption<SttProvider>[] = [
  { value: "auto", label: "Auto", desc: "Groq when a key is set, otherwise OpenRouter." },
  { value: "groq", label: "Groq", desc: "Free tier, fastest. A key is all it needs." },
  { value: "openrouter", label: "OpenRouter", desc: "Uses your existing key, a bit slower." },
  { value: "custom", label: "Custom server", desc: "Your own or a local machine." },
];

const POLISH_CHOICES: ChoiceOption<PolishProvider>[] = [
  { value: "openrouter", label: "OpenRouter", desc: "Widest model choice, cents per month." },
  { value: "groq", label: "Groq", desc: "Free tier covers the cleanup step too." },
  { value: "custom", label: "Custom server", desc: "Your own or a local machine." },
];

const OPENROUTER_STT: Recommendation[] = [
  { id: "google/gemini-2.5-flash", note: "Accurate, handles German well" },
  { id: "google/gemini-2.0-flash-001", note: "Cheaper, a little faster" },
];
const OPENROUTER_POLISH: Recommendation[] = [
  { id: "google/gemini-2.5-flash-lite", note: "Default, quick and cheap" },
  { id: "openai/gpt-4.1-mini", note: "Careful with formatting" },
  { id: "anthropic/claude-haiku-4.5", note: "Best at keeping your voice" },
];
const GROQ_STT: Recommendation[] = [
  { id: "whisper-large-v3-turbo", note: "Default, fastest" },
  { id: "whisper-large-v3", note: "Slower, slightly more accurate" },
];
const GROQ_POLISH: Recommendation[] = [
  { id: "llama-3.3-70b-versatile", note: "Default, best quality on the free tier" },
  { id: "llama-3.1-8b-instant", note: "Fastest, simpler cleanups" },
];

const LOCAL_HELP = "Works with LM Studio, Ollama, whisper.cpp server, LocalAI, any OpenAI-compatible API.";

/** Two different APIs: whisper.cpp has its own, everything else speaks OpenAI. */
const CUSTOM_API_CHOICES: ChoiceOption<ProvidersModel["customSttApi"]>[] = [
  { value: "whisper_cpp", label: "whisper.cpp", desc: "The server Spechy can download and start for you." },
  { value: "openai", label: "OpenAI-compatible", desc: "LM Studio, Speaches, LocalAI, your own server." },
];

export default function Providers() {
  const { settings, update, toast } = useStore();
  const p = settings.providers;
  const [testing, setTesting] = useState<ModelSource | null>(null);
  const [status, setStatus] = useState<Partial<Record<ModelSource, { ok: boolean; message: string }>>>({});
  const [library, setLibrary] = useState(false);
  const [localPick, setLocalPick] = useState<LocalModelFit | null>(null);
  const [server, setServer] = useState<LocalServerStatus | null>(null);

  const patch = (next: Partial<ProvidersModel>) => void update({ providers: { ...p, ...next } });

  // Best local model for this PC, shown next to the library button.
  useEffect(() => {
    void safeCall(() => api.listLocalModels(), "localModels", [] as LocalModelFit[])
      .then((list) => setLocalPick(list.find((entry) => entry.recommended) ?? null));
    void safeCall(() => api.localServerStatus(), "localServer", null as LocalServerStatus | null).then(setServer);
  }, []);

  /** Apply a library pick: the local whisper.cpp server on the chosen port. */
  const useLocal = (fit: LocalModelFit, port: number) => {
    patch({
      sttProvider: "custom",
      customSttApi: "whisper_cpp",
      customSttModel: fit.model.id,
      customSttBaseUrl: `http://127.0.0.1:${port}`,
      customSttApiKey: "",
    });
  };

  const test = async (provider: ModelSource, key: string) => {
    setTesting(provider);
    try {
      const message = await api.testProvider(provider, key);
      setStatus((s) => ({ ...s, [provider]: { ok: true, message } }));
    } catch (e) {
      setStatus((s) => ({ ...s, [provider]: { ok: false, message: String(e) } }));
      toast({ kind: "error", message: String(e) });
    }
    setTesting(null);
  };

  const keyRow = (provider: ModelSource, value: string, onChange: (v: string) => void, placeholder: string) => {
    const s = status[provider];
    return (
      <>
        <div className="set-key">
          <SecretInput value={value} onChange={(v) => { setStatus((st) => ({ ...st, [provider]: undefined })); onChange(v); }} placeholder={placeholder} />
          <Button variant="secondary" size="sm" disabled={testing === provider} onClick={() => void test(provider, value)}>
            {testing === provider ? "Testing" : "Test"}
          </Button>
        </div>
        {s && <div className={`pv-status ${s.ok ? "ok" : "bad"}`}>{s.message}</div>}
      </>
    );
  };

  const linkRow = (label: string, url: string) => (
    <Button variant="ghost" size="sm" onClick={() => void api.openUrl(url).catch(() => {})}>
      {label}
      <ExternalLink size={14} />
    </Button>
  );

  return (
    <>
      <Group label="Transcription">
        <div className="pv-block">
          <Choice value={p.sttProvider} options={STT_CHOICES} onChange={(v) => patch({ sttProvider: v })} />
        </div>

        {p.sttProvider !== "custom" && (
          <div className="pv-hint">
            <span>Prefer to keep audio on this PC? The local model library recommends whisper.cpp models for your hardware.</span>
            <Button variant="secondary" size="sm" onClick={() => setLibrary(true)}>
              <Library size={14} /> Browse local models
            </Button>
          </div>
        )}

        {(p.sttProvider === "auto" || p.sttProvider === "groq") && (
          <>
            <Row label="Groq API key" sub="Stored locally, never sent anywhere else." extra={linkRow("Get a key", "https://console.groq.com/keys")}>
              {keyRow("groq", p.groqApiKey, (v) => patch({ groqApiKey: v }), "gsk_...")}
            </Row>
            <Row label="Groq model">
              <ModelPicker
                value={p.groqModel}
                onChange={(id) => patch({ groqModel: id })}
                source="groq"
                recommended={GROQ_STT}
                audioOnly
              />
            </Row>
          </>
        )}

        {(p.sttProvider === "auto" || p.sttProvider === "openrouter") && (
          <>
            <Row label="OpenRouter API key" sub="Also the stand in when Groq is rate limited." extra={linkRow("Get a key", "https://openrouter.ai/settings/keys")}>
              {keyRow("openrouter", p.openrouterApiKey, (v) => patch({ openrouterApiKey: v }), "sk-or-...")}
            </Row>
            <Row label="OpenRouter model" sub="Needs a model that can take audio.">
              <ModelPicker
                value={p.openrouterSttModel}
                onChange={(id) => patch({ openrouterSttModel: id })}
                source="openrouter"
                recommended={OPENROUTER_STT}
                audioOnly
              />
            </Row>
          </>
        )}

        {p.sttProvider === "custom" && (
          <>
            <div className="pv-block">
              <Choice
                value={p.customSttApi}
                options={CUSTOM_API_CHOICES}
                onChange={(v) => patch({
                  customSttApi: v,
                  customSttBaseUrl: v === "whisper_cpp" && !p.customSttBaseUrl.trim() ? "http://127.0.0.1:8178" : p.customSttBaseUrl,
                })}
              />
            </div>

            {p.customSttApi === "whisper_cpp" && (
              <div className="pv-block pv-local">
                <div className="pv-local-text">
                  <div className="pv-local-title">
                    Local model library
                    <span className={`mlib-badge ${server?.running ? "rec" : server?.installed ? "fit-great" : "fit-too_big"}`}>
                      {server?.running ? "Running" : server?.installed ? "Ready" : "Not installed"}
                    </span>
                  </div>
                  <div className="pv-local-sub muted">
                    {server?.running
                      ? `Serving ${server.modelId} on 127.0.0.1:${server.port}.`
                      : server?.installed
                        ? "The whisper.cpp server is unpacked. Open the library to start a model."
                        : "Download the whisper.cpp server for this PC, then start a model. 9 MB for the CPU build."}
                    {localPick && !server?.running ? ` Best match: ${localPick.model.name}.` : ""}
                  </div>
                </div>
                <Button variant="secondary" size="sm" onClick={() => setLibrary(true)}>
                  <Library size={14} /> Open library
                </Button>
              </div>
            )}

            <Row
              label="Server address"
              sub={p.customSttApi === "whisper_cpp"
                ? "Where the local server listens. The library fills this in when it starts a model."
                : LOCAL_HELP}
            >
              <input
                className="input set-input"
                value={p.customSttBaseUrl}
                placeholder={p.customSttApi === "whisper_cpp" ? "http://127.0.0.1:8178" : "http://localhost:8000/v1"}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => patch({ customSttBaseUrl: e.target.value })}
              />
            </Row>

            {p.customSttApi === "openai" && (
              <Row label="API key" sub="Leave empty when your server needs none.">
                {keyRow("custom_stt", p.customSttApiKey, (v) => patch({ customSttApiKey: v }), "optional")}
              </Row>
            )}

            <Row
              label="Model"
              sub={p.customSttApi === "whisper_cpp" ? "The model the local server was started with." : undefined}
            >
              <ModelPicker
                value={p.customSttModel}
                onChange={(id) => patch({ customSttModel: id })}
                source="custom_stt"
                placeholder="Pick or type a model"
              />
            </Row>
          </>
        )}
      </Group>

      <Group label="Cleanup">
        <Row label="Clean up the transcript" sub="Punctuation, capitalization, filler words, your style rules.">
          <Toggle on={p.polishEnabled} onChange={(v) => patch({ polishEnabled: v })} />
        </Row>

        {p.polishEnabled && (
          <>
            <div className="pv-block">
              <Choice value={p.polishProvider} options={POLISH_CHOICES} onChange={(v) => patch({ polishProvider: v })} />
            </div>

            {p.polishProvider === "openrouter" && (
              <>
                <Row label="OpenRouter API key" extra={linkRow("Get a key", "https://openrouter.ai/settings/keys")}>
                  {keyRow("openrouter", p.openrouterApiKey, (v) => patch({ openrouterApiKey: v }), "sk-or-...")}
                </Row>
                <Row label="Cleanup model">
                  <ModelPicker
                    value={p.polishModel}
                    onChange={(id) => patch({ polishModel: id })}
                    source="openrouter"
                    recommended={OPENROUTER_POLISH}
                  />
                </Row>
              </>
            )}

            {p.polishProvider === "groq" && (
              <>
                <Row label="Groq API key" extra={linkRow("Get a key", "https://console.groq.com/keys")}>
                  {keyRow("groq", p.groqApiKey, (v) => patch({ groqApiKey: v }), "gsk_...")}
                </Row>
                <Row label="Cleanup model">
                  <ModelPicker
                    value={p.groqPolishModel}
                    onChange={(id) => patch({ groqPolishModel: id })}
                    source="groq"
                    recommended={GROQ_POLISH}
                  />
                </Row>
              </>
            )}

            {p.polishProvider === "custom" && (
              <>
                <Row label="Server address" sub={LOCAL_HELP}>
                  <input
                    className="input set-input"
                    value={p.customPolishBaseUrl}
                    placeholder="http://localhost:11434/v1"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => patch({ customPolishBaseUrl: e.target.value })}
                  />
                </Row>
                <Row label="API key" sub="Leave empty when your server needs none.">
                  {keyRow("custom_polish", p.customPolishApiKey, (v) => patch({ customPolishApiKey: v }), "optional")}
                </Row>
                <Row label="Model">
                  <ModelPicker
                    value={p.customPolishModel}
                    onChange={(id) => patch({ customPolishModel: id })}
                    source="custom_polish"
                    placeholder="Pick or type a model"
                  />
                </Row>
              </>
            )}
          </>
        )}
      </Group>

      <div className="set-note">
        <span>Groq's free tier needs no credit, just a key: console.groq.com/keys</span>
        <Button variant="secondary" size="sm" onClick={() => void api.openUrl("https://console.groq.com/keys").catch(() => {})}>
          Open
        </Button>
      </div>

      {library && <ModelLibrary onClose={() => setLibrary(false)} onUse={useLocal} />}
    </>
  );
}
