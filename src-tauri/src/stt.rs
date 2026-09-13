//! Speech to text over any OpenAI-compatible transcription endpoint (Groq, a local
//! whisper server, ...) or an audio-capable OpenRouter chat model, plus the model
//! catalogue the settings picker reads.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine;

use crate::model::{ModelInfo, Providers};

/// Base urls up to and including the version segment; every call appends its path.
pub const GROQ_BASE: &str = "https://api.groq.com/openai/v1";
pub const OPENROUTER_BASE: &str = "https://openrouter.ai/api/v1";
const TIMEOUT_SECS: u64 = 25;
/// How long a fetched model list stays valid.
const MODEL_CACHE_MS: i64 = 10 * 60 * 1000;

const OPENROUTER_SYSTEM: &str = "You are a transcription engine. Output only the verbatim transcript, no quotes, no commentary. If the audio is silent output an empty string.";

pub struct SttRequest<'a> {
    pub wav: &'a [u8],
    pub languages: &'a [String],
    /// Dictionary words handed to the model as a vocabulary hint.
    pub vocabulary: &'a [String],
    /// Partial requests come from the live transcript while recording.
    pub partial: bool,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
}

/// Glue a base url and a path together without doubling or losing the slash.
pub fn join_url(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim().trim_end_matches('/'), path.trim_start_matches('/'))
}

/// Vocabulary joined into a Whisper prompt, capped so the prompt stays cheap.
fn vocabulary_prompt(vocabulary: &[String]) -> String {
    let mut out = String::new();
    for word in vocabulary {
        let word = word.trim();
        if word.is_empty() {
            continue;
        }
        if out.len() + word.len() + 2 > 800 {
            break;
        }
        if !out.is_empty() {
            out.push_str(", ");
        }
        out.push_str(word);
    }
    out
}

/// Which provider handles this request.
fn pick_provider(p: &Providers) -> Result<&'static str, String> {
    let groq = !p.groq_api_key.trim().is_empty();
    let openrouter = !p.openrouter_api_key.trim().is_empty();
    match p.stt_provider.as_str() {
        "groq" => {
            if groq {
                Ok("groq")
            } else {
                Err("No Groq API key is set. Add one in Settings.".into())
            }
        }
        "openrouter" => {
            if openrouter {
                Ok("openrouter")
            } else {
                Err("No OpenRouter API key is set. Add one in Settings.".into())
            }
        }
        "custom" => {
            if p.custom_stt_base_url.trim().is_empty() {
                Err("No address is set for your transcription server. Add one in Settings.".into())
            } else if p.custom_stt_model.trim().is_empty() {
                Err("No model is selected for your transcription server. Pick one in Settings.".into())
            } else {
                Ok("custom")
            }
        }
        // "auto" never reaches for a custom server: that stays a deliberate choice.
        _ => {
            if groq {
                Ok("groq")
            } else if openrouter {
                Ok("openrouter")
            } else {
                Err("No API key is set. Add a Groq or OpenRouter key in Settings.".into())
            }
        }
    }
}

pub fn transcribe(providers: &Providers, req: SttRequest) -> Result<String, String> {
    if req.wav.len() < 1024 {
        return Ok(String::new());
    }
    match pick_provider(providers)? {
        "groq" => match transcribe_openai_compatible(
            GROQ_BASE,
            &providers.groq_api_key,
            &providers.groq_model,
            &req,
            "Groq",
        ) {
            // Groq's free tier allows about 20 requests per minute. When it pushes back,
            // fall back to OpenRouter for this request instead of losing the dictation.
            Err(message) if message.contains("rate limited") && !providers.openrouter_api_key.trim().is_empty() => {
                log::warn!("groq rate limited, falling back to openrouter for this request");
                transcribe_openrouter(providers, &req)
            }
            other => other,
        },
        "custom" => transcribe_openai_compatible(
            &providers.custom_stt_base_url,
            &providers.custom_stt_api_key,
            &providers.custom_stt_model,
            &req,
            "Your server",
        ),
        _ => transcribe_openrouter(providers, &req),
    }
}

// ---------- OpenAI-compatible transcription (Groq, whisper.cpp server, Speaches, ...) ----------

/// Build a multipart/form-data body by hand: text fields plus the WAV file.
fn multipart_body(boundary: &str, fields: &[(&str, &str)], wav: &[u8]) -> Vec<u8> {
    let mut body: Vec<u8> = Vec::with_capacity(wav.len() + 1024);
    for (name, value) in fields {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(value.as_bytes());
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n",
    );
    body.extend_from_slice(wav);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

/// POST {base_url}/audio/transcriptions as multipart. Works with Groq and with every
/// local OpenAI-compatible server (whisper.cpp server, faster-whisper-server, Speaches,
/// LM Studio, LocalAI). An empty key means the endpoint gets no Authorization header.
fn transcribe_openai_compatible(
    base_url: &str,
    api_key: &str,
    model: &str,
    req: &SttRequest,
    label: &str,
) -> Result<String, String> {
    let boundary = format!("----spechy{}", crate::model::now_ms());
    let prompt = vocabulary_prompt(req.vocabulary);
    let model = model.trim();
    let mut fields: Vec<(&str, &str)> = vec![
        ("model", model),
        ("response_format", "json"),
        ("temperature", "0"),
    ];
    if req.languages.len() == 1 {
        fields.push(("language", req.languages[0].as_str()));
    }
    if !prompt.is_empty() {
        fields.push(("prompt", prompt.as_str()));
    }
    let body = multipart_body(&boundary, &fields, req.wav);

    let mut request = agent()
        .post(&join_url(base_url, "audio/transcriptions"))
        .set("Content-Type", &format!("multipart/form-data; boundary={boundary}"));
    if !api_key.trim().is_empty() {
        request = request.set("Authorization", &format!("Bearer {}", api_key.trim()));
    }

    let json: serde_json::Value = match request.send_bytes(&body) {
        Ok(r) => r.into_json().map_err(|e| format!("{label} sent an unreadable answer: {e}"))?,
        Err(e) => return Err(map_error(label, e)),
    };
    Ok(json.get("text").and_then(|v| v.as_str()).unwrap_or_default().trim().to_string())
}

// ---------- OpenRouter ----------

fn transcribe_openrouter(p: &Providers, req: &SttRequest) -> Result<String, String> {
    let audio = base64::engine::general_purpose::STANDARD.encode(req.wav);
    let mut instruction = String::from("Transcribe this audio verbatim.");
    if req.languages.len() == 1 {
        instruction.push_str(&format!(" The language is {}.", req.languages[0]));
    }
    let vocabulary = vocabulary_prompt(req.vocabulary);
    if !vocabulary.is_empty() {
        instruction.push_str(&format!(" Expected terms: {vocabulary}."));
    }
    if req.partial {
        instruction.push_str(" The recording may end mid sentence, transcribe what is there.");
    }

    let payload = serde_json::json!({
        "model": p.openrouter_stt_model,
        "temperature": 0,
        "messages": [
            { "role": "system", "content": OPENROUTER_SYSTEM },
            { "role": "user", "content": [
                { "type": "input_audio", "input_audio": { "data": audio, "format": "wav" } },
                { "type": "text", "text": instruction }
            ]}
        ]
    });

    let response = agent()
        .post(&join_url(OPENROUTER_BASE, "chat/completions"))
        .set("Authorization", &format!("Bearer {}", p.openrouter_api_key.trim()))
        .set("Content-Type", "application/json")
        .set("HTTP-Referer", "https://remos.systems")
        .set("X-Title", "Spechy")
        .send_json(payload);

    let json: serde_json::Value = match response {
        Ok(r) => r.into_json().map_err(|e| format!("OpenRouter sent an unreadable answer: {e}"))?,
        Err(e) => return Err(map_error("OpenRouter", e)),
    };
    Ok(chat_content(&json).trim().to_string())
}

/// First choice message content of an OpenAI-style chat completion.
pub fn chat_content(json: &serde_json::Value) -> String {
    json.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or_default()
        .to_string()
}

// ---------- Errors and key test ----------

/// Turn a ureq error into something a person can act on.
pub fn map_error(provider: &str, err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(code, response) => {
            let detail = response
                .into_string()
                .ok()
                .and_then(|body| {
                    serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| {
                            v.get("error")
                                .and_then(|e| e.get("message"))
                                .and_then(|m| m.as_str())
                                .map(|s| s.to_string())
                        })
                })
                .unwrap_or_default();
            match code {
                401 | 403 => format!("{provider}: invalid API key"),
                402 => format!("{provider}: out of credits"),
                413 => format!("{provider}: the recording is too long"),
                429 => format!("{provider}: rate limited, try again"),
                500..=599 => format!("{provider}: the service is having trouble, try again"),
                _ if !detail.is_empty() => format!("{provider}: {detail}"),
                _ => format!("{provider}: request failed ({code})"),
            }
        }
        ureq::Error::Transport(t) => format!("{provider}: no connection ({t})"),
    }
}

/// GET {base_url}/models as JSON. Only OpenRouter gets its extra courtesy headers.
fn fetch_models_json(base_url: &str, key: &str, label: &str, openrouter: bool) -> Result<serde_json::Value, String> {
    let mut request = agent().get(&join_url(base_url, "models"));
    if !key.trim().is_empty() {
        request = request.set("Authorization", &format!("Bearer {}", key.trim()));
    }
    if openrouter {
        request = request.set("HTTP-Referer", "https://remos.systems").set("X-Title", "Spechy");
    }
    match request.call() {
        Ok(r) => r
            .into_json()
            .map_err(|e| format!("{label} sent an unreadable answer: {e}")),
        Err(e) => Err(map_error(label, e)),
    }
}

/// Lightweight check against the models endpoint of a provider.
pub fn test_key(provider: &str, key: &str) -> Result<String, String> {
    let (base, key, label, openrouter) = match provider {
        "groq" => (GROQ_BASE.to_string(), key.trim().to_string(), "Groq", false),
        "openrouter" => (OPENROUTER_BASE.to_string(), key.trim().to_string(), "OpenRouter", true),
        "custom_stt" | "custom_polish" => {
            let p = crate::settings::current().providers;
            let base = if provider == "custom_stt" { p.custom_stt_base_url } else { p.custom_polish_base_url };
            if base.trim().is_empty() {
                return Err("Enter the server address first".into());
            }
            (base, key.trim().to_string(), "Your server", false)
        }
        other => return Err(format!("Unknown provider: {other}")),
    };
    if key.is_empty() && !provider.starts_with("custom") {
        return Err("The key is empty".into());
    }

    match fetch_models_json(&base, &key, label, openrouter) {
        Ok(json) => {
            let count = json.get("data").and_then(|d| d.as_array()).map(|a| a.len()).unwrap_or(0);
            Ok(format!("OK ({count} models)"))
        }
        // A local server may not list models at all; a reachable base url is good enough.
        Err(e) if provider.starts_with("custom") => match agent().request("HEAD", base.trim()).call() {
            Ok(_) => Ok("OK (server answers, but it lists no models)".into()),
            Err(_) => Err(e),
        },
        Err(e) => Err(e),
    }
}

// ---------- Model catalogue ----------

/// provider key -> (fetched at, models). Kept for MODEL_CACHE_MS so opening the
/// picker a second time does not hit the network again.
static MODEL_CACHE: Mutex<Option<HashMap<String, (i64, Vec<ModelInfo>)>>> = Mutex::new(None);

fn cached_models(provider: &str) -> Option<Vec<ModelInfo>> {
    let guard = MODEL_CACHE.lock().ok()?;
    let (at, models) = guard.as_ref()?.get(provider)?;
    if crate::model::now_ms() - at > MODEL_CACHE_MS {
        return None;
    }
    Some(models.clone())
}

fn cache_models(provider: &str, models: &[ModelInfo]) {
    if let Ok(mut guard) = MODEL_CACHE.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(provider.to_string(), (crate::model::now_ms(), models.to_vec()));
    }
}

/// Turn one provider's models payload into our flat list.
fn parse_models(json: &serde_json::Value, kind: &str) -> Vec<ModelInfo> {
    let empty = vec![];
    let data = json.get("data").and_then(|d| d.as_array()).unwrap_or(&empty);
    let mut out: Vec<ModelInfo> = data
        .iter()
        .filter_map(|m| {
            let id = m.get("id").and_then(|v| v.as_str())?.to_string();
            if id.is_empty() {
                return None;
            }
            let name = m
                .get("name")
                .and_then(|v| v.as_str())
                .filter(|n| !n.is_empty())
                .unwrap_or(&id)
                .to_string();
            let (audio, free) = match kind {
                "openrouter" => {
                    let audio = m
                        .get("architecture")
                        .and_then(|a| a.get("input_modalities"))
                        .and_then(|v| v.as_array())
                        .map(|list| list.iter().any(|v| v.as_str() == Some("audio")))
                        .unwrap_or(false);
                    let free = m
                        .get("pricing")
                        .and_then(|p| p.get("prompt"))
                        .and_then(|v| v.as_str())
                        .map(|p| p == "0")
                        .unwrap_or(false);
                    (audio, free)
                }
                "groq" => (id.contains("whisper"), false),
                // A local server tells us nothing about modalities or price.
                _ => (false, false),
            };
            Some(ModelInfo { id, name, audio, free })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Every model a provider offers. `provider` is "groq", "openrouter", "custom_stt"
/// or "custom_polish"; the custom ones read their base url from the settings.
pub fn list_models(provider: &str, refresh: bool) -> Result<Vec<ModelInfo>, String> {
    if !refresh {
        if let Some(hit) = cached_models(provider) {
            return Ok(hit);
        }
    }
    let p = crate::settings::current().providers;
    let (base, key, label, kind) = match provider {
        "groq" => (GROQ_BASE.to_string(), p.groq_api_key, "Groq", "groq"),
        "openrouter" => (OPENROUTER_BASE.to_string(), p.openrouter_api_key, "OpenRouter", "openrouter"),
        "custom_stt" => (p.custom_stt_base_url, p.custom_stt_api_key, "Your server", "custom"),
        "custom_polish" => (p.custom_polish_base_url, p.custom_polish_api_key, "Your server", "custom"),
        other => return Err(format!("Unknown provider: {other}")),
    };
    if base.trim().is_empty() {
        return Err("No server address is set yet".into());
    }
    if key.trim().is_empty() && kind != "custom" {
        return Err(format!("No {label} API key is set yet"));
    }
    let json = fetch_models_json(&base, &key, label, kind == "openrouter")?;
    let models = parse_models(&json, kind);
    cache_models(provider, &models);
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocabulary_prompt_joins_and_caps() {
        let words: Vec<String> = vec!["Spechy".into(), "".into(), "AI-OS".into()];
        assert_eq!(vocabulary_prompt(&words), "Spechy, AI-OS");
        let many: Vec<String> = (0..500).map(|i| format!("word{i}")).collect();
        assert!(vocabulary_prompt(&many).len() <= 800);
    }

    #[test]
    fn join_url_handles_slashes() {
        assert_eq!(join_url("http://localhost:1234/v1", "models"), "http://localhost:1234/v1/models");
        assert_eq!(join_url("http://localhost:1234/v1/", "/models"), "http://localhost:1234/v1/models");
        assert_eq!(join_url("  https://api.groq.com/openai/v1  ", "audio/transcriptions"), "https://api.groq.com/openai/v1/audio/transcriptions");
    }

    #[test]
    fn custom_is_never_picked_automatically() {
        let mut p = Providers::default();
        p.custom_stt_base_url = "http://localhost:8000/v1".into();
        p.custom_stt_model = "whisper-1".into();
        p.groq_api_key = "gsk_test".into();
        assert_eq!(pick_provider(&p).unwrap(), "groq");
        p.stt_provider = "custom".into();
        assert_eq!(pick_provider(&p).unwrap(), "custom");
        p.custom_stt_model = String::new();
        assert!(pick_provider(&p).is_err());
    }

    #[test]
    fn parse_models_reads_openrouter_and_groq_shapes() {
        let openrouter = serde_json::json!({ "data": [
            { "id": "google/gemini-2.5-flash", "name": "Gemini 2.5 Flash",
              "architecture": { "input_modalities": ["text", "image", "audio"] },
              "pricing": { "prompt": "0.0000003" } },
            { "id": "free/model", "name": "", "pricing": { "prompt": "0" } }
        ]});
        let list = parse_models(&openrouter, "openrouter");
        assert_eq!(list.len(), 2);
        let gemini = list.iter().find(|m| m.id == "google/gemini-2.5-flash").unwrap();
        assert!(gemini.audio && !gemini.free);
        let free = list.iter().find(|m| m.id == "free/model").unwrap();
        assert!(free.free && !free.audio);
        // An empty name falls back to the id.
        assert_eq!(free.name, "free/model");

        let groq = serde_json::json!({ "data": [
            { "id": "whisper-large-v3-turbo" }, { "id": "llama-3.3-70b-versatile" }
        ]});
        let list = parse_models(&groq, "groq");
        assert!(list[1].audio);
        assert!(!list[0].audio);
    }

    #[test]
    fn multipart_body_contains_fields_and_file() {
        let body = multipart_body("BOUND", &[("model", "whisper")], b"RIFFdata");
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("name=\"model\""));
        assert!(text.contains("whisper"));
        assert!(text.contains("filename=\"audio.wav\""));
        assert!(text.ends_with("--BOUND--\r\n"));
    }
}
