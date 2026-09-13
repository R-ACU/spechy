//! Cleaning up a raw transcript: deterministic snippet and dictionary passes
//! around an optional LLM polish step.

use crate::model::{DictionaryEntry, Settings, Snippet};
use crate::stt::{join_url, GROQ_BASE, OPENROUTER_BASE};
use crate::winutil::ForegroundApp;

const TIMEOUT_SECS: u64 = 25;

pub struct PolishContext<'a> {
    pub raw: &'a str,
    pub settings: &'a Settings,
    pub dictionary: &'a [DictionaryEntry],
    pub snippets: &'a [Snippet],
    pub app: &'a ForegroundApp,
    /// Coding or terminal context: keep technical tokens verbatim.
    pub vibe: bool,
    /// Command mode: apply this spoken instruction to `selection`.
    pub command_instruction: Option<&'a str>,
    pub selection: Option<&'a str>,
}

#[derive(Debug, Default, Clone)]
pub struct PolishResult {
    pub text: String,
    pub used_dictionary: Vec<String>,
    pub used_snippets: Vec<String>,
}

// ---------- Deterministic passes ----------

/// True when `haystack[at..at+len]` is not glued to a word character on either side.
fn is_whole_match(haystack: &[char], at: usize, len: usize) -> bool {
    let before_ok = at == 0 || !haystack[at - 1].is_alphanumeric();
    let end = at + len;
    let after_ok = end >= haystack.len() || !haystack[end].is_alphanumeric();
    before_ok && after_ok
}

/// Case-insensitive whole-phrase replacement. Returns the new text and the hit count.
fn replace_phrase(text: &str, needle: &str, replacement: &str) -> (String, usize) {
    let needle_lower: Vec<char> = needle.to_lowercase().chars().collect();
    if needle_lower.is_empty() {
        return (text.to_string(), 0);
    }
    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = text.to_lowercase().chars().collect();
    // A locale-dependent lowercase can change the length (for example the German sharp s);
    // in that rare case skip the replacement instead of slicing wrongly.
    if lower.len() != chars.len() {
        return (text.to_string(), 0);
    }
    let mut out = String::with_capacity(text.len());
    let mut hits = 0usize;
    let mut i = 0usize;
    while i < chars.len() {
        if i + needle_lower.len() <= chars.len()
            && lower[i..i + needle_lower.len()] == needle_lower[..]
            && is_whole_match(&lower, i, needle_lower.len())
        {
            out.push_str(replacement);
            i += needle_lower.len();
            hits += 1;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    (out, hits)
}

/// Snippet pass: longest trigger first, also matching a trigger that carries
/// trailing punctuation from the transcript ("sign off." -> the snippet text).
fn apply_snippets(text: &str, snippets: &[Snippet]) -> (String, Vec<String>) {
    let mut ordered: Vec<&Snippet> = snippets.iter().filter(|s| !s.trigger.trim().is_empty()).collect();
    ordered.sort_by(|a, b| b.trigger.chars().count().cmp(&a.trigger.chars().count()));

    let mut out = text.to_string();
    let mut used = Vec::new();
    for snippet in ordered {
        let trigger = snippet.trigger.trim();
        let mut hits = 0usize;
        // Punctuated variants first so the trailing mark is swallowed with the trigger.
        for suffix in [".", "!", "?", ","] {
            let (next, n) = replace_phrase(&out, &format!("{trigger}{suffix}"), &snippet.text);
            out = next;
            hits += n;
        }
        let (next, n) = replace_phrase(&out, trigger, &snippet.text);
        out = next;
        hits += n;
        if hits > 0 {
            used.push(snippet.id.clone());
        }
    }
    (out, used)
}

/// Dictionary pass: every misspelling becomes the correct word (whole word, case-insensitive).
fn apply_dictionary(text: &str, dictionary: &[DictionaryEntry]) -> (String, Vec<String>, i64) {
    let mut out = text.to_string();
    let mut used = Vec::new();
    let mut total = 0i64;
    let mut ordered: Vec<&DictionaryEntry> = dictionary
        .iter()
        .filter(|d| !d.misspelling.trim().is_empty() && !d.word.trim().is_empty())
        .collect();
    ordered.sort_by(|a, b| b.misspelling.chars().count().cmp(&a.misspelling.chars().count()));
    for entry in ordered {
        let (next, hits) = replace_phrase(&out, entry.misspelling.trim(), entry.word.trim());
        out = next;
        if hits > 0 {
            used.push(entry.id.clone());
            total += hits as i64;
        }
    }
    (out, used, total)
}

/// Remove wrapping quotes or a markdown code fence a model may have added.
pub fn strip_wrapping(text: &str) -> String {
    let mut t = text.trim().to_string();
    if t.starts_with("```") {
        if let Some(rest) = t.strip_prefix("```") {
            let rest = match rest.find('\n') {
                Some(idx) => &rest[idx + 1..],
                None => rest,
            };
            t = rest.trim_end().trim_end_matches("```").trim_end().to_string();
        }
    }
    let t = t.trim();
    let pairs = [('"', '"'), ('\'', '\''), ('\u{201c}', '\u{201d}'), ('\u{201e}', '\u{201c}')];
    for (open, close) in pairs {
        let chars: Vec<char> = t.chars().collect();
        if chars.len() >= 2 && chars[0] == open && chars[chars.len() - 1] == close {
            let inner: String = chars[1..chars.len() - 1].iter().collect();
            // Only unwrap when the quotes really wrap the whole text.
            if !inner.contains(close) {
                return inner.trim().to_string();
            }
        }
    }
    t.to_string()
}

// ---------- Prompt ----------

fn tone_for(ctx: &PolishContext) -> String {
    let haystack = format!("{} {}", ctx.app.process_name, ctx.app.title).to_lowercase();
    for rule in &ctx.settings.style.app_rules {
        let needle = rule.app_match.trim().to_lowercase();
        if !needle.is_empty() && haystack.contains(&needle) {
            return rule.tone.clone();
        }
    }
    ctx.settings.style.default_tone.clone()
}

fn app_note(ctx: &PolishContext) -> String {
    let haystack = format!("{} {}", ctx.app.process_name, ctx.app.title).to_lowercase();
    for rule in &ctx.settings.style.app_rules {
        let needle = rule.app_match.trim().to_lowercase();
        if !needle.is_empty() && haystack.contains(&needle) && !rule.note.trim().is_empty() {
            return rule.note.trim().to_string();
        }
    }
    String::new()
}

/// The system prompt for the polish step.
pub fn build_system_prompt(ctx: &PolishContext) -> String {
    let mut p = String::new();
    p.push_str("You are the text cleanup engine of Spechy, a voice dictation app. ");
    p.push_str("You receive a raw speech transcript and return the cleaned text that the user wants to type.\n");
    p.push_str("Rules:\n");
    p.push_str("- Output only the resulting text. Never answer the content, never add anything, never comment.\n");
    p.push_str("- Keep the language of the speaker. German stays German, English stays English.\n");
    p.push_str("- Fix punctuation, capitalization and obvious transcription errors.\n");
    if ctx.settings.style.keep_fillers {
        p.push_str("- Keep filler words as spoken.\n");
    } else {
        p.push_str("- Remove filler words and false starts (ah, oehm, you know, I mean).\n");
    }
    p.push_str("- Spoken punctuation words become symbols: Punkt, Komma, Fragezeichen, neue Zeile, neuer Absatz, period, comma, question mark, new line, new paragraph.\n");
    p.push_str("- No markdown formatting unless the speaker asked for a list or headings.\n");
    p.push_str(&format!("- Tone: {}.\n", tone_for(ctx)));
    let note = app_note(ctx);
    if !note.is_empty() {
        p.push_str(&format!("- Context note for this app: {note}\n"));
    }
    if !ctx.app.process_name.is_empty() {
        p.push_str(&format!(
            "- The text is going into {} (window title: {}).\n",
            ctx.app.process_name, ctx.app.title
        ));
    }
    if ctx.vibe {
        p.push_str("- Coding context: keep file names, paths, commands, flags and code identifiers verbatim. Do not prosify them, do not translate them.\n");
    }
    let custom = ctx.settings.style.custom_rules.trim();
    if !custom.is_empty() {
        p.push_str(&format!("- User rules: {custom}\n"));
    }

    let words: Vec<&str> = ctx
        .dictionary
        .iter()
        .map(|d| d.word.trim())
        .filter(|w| !w.is_empty())
        .take(120)
        .collect();
    if !words.is_empty() {
        p.push_str(&format!(
            "- Known vocabulary, spell these exactly and fix similar sounding words to them: {}\n",
            words.join(", ")
        ));
    }
    let triggers: Vec<String> = ctx
        .snippets
        .iter()
        .filter(|s| !s.trigger.trim().is_empty())
        .take(40)
        .map(|s| format!("\"{}\" -> \"{}\"", s.trigger.trim(), s.text.trim()))
        .collect();
    if !triggers.is_empty() {
        p.push_str(&format!(
            "- Snippet triggers, replace a spoken trigger with its text: {}\n",
            triggers.join("; ")
        ));
    }
    p
}

// ---------- OpenAI-compatible chat call ----------

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
}

/// Where the cleanup step sends its request.
struct ChatTarget {
    base_url: String,
    api_key: String,
    model: String,
    /// OpenRouter wants two extra headers for attribution.
    openrouter: bool,
    label: &'static str,
}

/// Resolve `polish_provider` into a concrete endpoint, or say what is missing.
fn polish_target(settings: &Settings) -> Result<ChatTarget, String> {
    let p = &settings.providers;
    match p.polish_provider.as_str() {
        "groq" => {
            if p.groq_api_key.trim().is_empty() {
                return Err("No Groq API key is set. Add one in Settings.".into());
            }
            if p.groq_polish_model.trim().is_empty() {
                return Err("No Groq cleanup model is selected. Pick one in Settings.".into());
            }
            Ok(ChatTarget {
                base_url: GROQ_BASE.into(),
                api_key: p.groq_api_key.trim().into(),
                model: p.groq_polish_model.trim().into(),
                openrouter: false,
                label: "Groq",
            })
        }
        "custom" => {
            if p.custom_polish_base_url.trim().is_empty() {
                return Err("No address is set for your cleanup server. Add one in Settings.".into());
            }
            if p.custom_polish_model.trim().is_empty() {
                return Err("No model is selected for your cleanup server. Pick one in Settings.".into());
            }
            Ok(ChatTarget {
                base_url: p.custom_polish_base_url.trim().into(),
                api_key: p.custom_polish_api_key.trim().into(),
                model: p.custom_polish_model.trim().into(),
                openrouter: false,
                label: "Your server",
            })
        }
        _ => {
            if p.openrouter_api_key.trim().is_empty() {
                return Err("No OpenRouter API key is set. Add one in Settings.".into());
            }
            if p.polish_model.trim().is_empty() {
                return Err("No OpenRouter cleanup model is selected. Pick one in Settings.".into());
            }
            Ok(ChatTarget {
                base_url: OPENROUTER_BASE.into(),
                api_key: p.openrouter_api_key.trim().into(),
                model: p.polish_model.trim().into(),
                openrouter: true,
                label: "OpenRouter",
            })
        }
    }
}

/// One chat completion against any OpenAI-compatible endpoint. An empty key means
/// the endpoint gets no Authorization header (local servers usually want none).
fn chat(settings: &Settings, system: &str, user: &str, temperature: f64) -> Result<String, String> {
    let target = polish_target(settings)?;
    let payload = serde_json::json!({
        "model": target.model,
        "temperature": temperature,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ]
    });
    let mut request = agent()
        .post(&join_url(&target.base_url, "chat/completions"))
        .set("Content-Type", "application/json");
    if !target.api_key.is_empty() {
        request = request.set("Authorization", &format!("Bearer {}", target.api_key));
    }
    if target.openrouter {
        request = request.set("HTTP-Referer", "https://remos.systems").set("X-Title", "Spechy");
    }
    let json: serde_json::Value = match request.send_json(payload) {
        Ok(r) => r.into_json().map_err(|e| format!("{} sent an unreadable answer: {e}", target.label))?,
        Err(e) => return Err(crate::stt::map_error(target.label, e)),
    };
    let content = crate::stt::chat_content(&json);
    if content.trim().is_empty() {
        return Err(format!("{} returned an empty answer", target.label));
    }
    Ok(strip_wrapping(&content))
}

// ---------- Entry point ----------

/// Clean up a transcript. Deterministic passes always run; the LLM step is optional.
pub fn polish(ctx: PolishContext) -> Result<PolishResult, String> {
    // Command mode has its own shape: an instruction applied to a selection.
    if let Some(instruction) = ctx.command_instruction {
        let selection = ctx.selection.unwrap_or_default();
        let system = "Apply the spoken instruction to the given text and output only the resulting text. Never comment, never explain, never add quotes.";
        let user = format!("Instruction: {}\n\nText:\n{}", instruction.trim(), selection);
        let text = chat(ctx.settings, system, &user, 0.2)?;
        return Ok(PolishResult { text, ..Default::default() });
    }

    // 1) Snippets, 2) dictionary.
    let (after_snippets, used_snippets) = apply_snippets(ctx.raw, ctx.snippets);
    let (after_dict, mut used_dictionary, _) = apply_dictionary(&after_snippets, ctx.dictionary);

    let polish_possible = ctx.settings.providers.polish_enabled
        && polish_target(ctx.settings).is_ok()
        && !after_dict.trim().is_empty();

    if !polish_possible {
        return Ok(PolishResult { text: after_dict, used_dictionary, used_snippets });
    }

    // 3) LLM polish.
    let system = build_system_prompt(&ctx);
    let polished = chat(ctx.settings, &system, &after_dict, 0.2)?;

    // 4) Dictionary again, in case the model reintroduced a misspelling.
    let (final_text, used_again, _) = apply_dictionary(&polished, ctx.dictionary);
    for id in used_again {
        if !used_dictionary.contains(&id) {
            used_dictionary.push(id);
        }
    }

    Ok(PolishResult { text: final_text, used_dictionary, used_snippets })
}

/// Run a named transform prompt over a text.
pub fn apply_transform(prompt: &str, text: &str, settings: &Settings) -> Result<String, String> {
    if text.trim().is_empty() {
        return Ok(String::new());
    }
    chat(settings, prompt, text, 0.2)
}

/// How many dictionary replacements the deterministic pass would apply (stats only).
pub fn dictionary_fix_count(text: &str, dictionary: &[DictionaryEntry]) -> i64 {
    apply_dictionary(text, dictionary).2
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::now_ms;

    fn dict(word: &str, misspelling: &str) -> DictionaryEntry {
        DictionaryEntry {
            id: format!("d-{word}"),
            word: word.into(),
            misspelling: misspelling.into(),
            auto_learned: false,
            starred: false,
            created_at: now_ms(),
            uses: 0,
        }
    }

    fn snip(id: &str, trigger: &str, text: &str) -> Snippet {
        Snippet { id: id.into(), trigger: trigger.into(), text: text.into(), created_at: now_ms(), uses: 0 }
    }

    fn ctx_for<'a>(
        raw: &'a str,
        settings: &'a Settings,
        dictionary: &'a [DictionaryEntry],
        snippets: &'a [Snippet],
        app: &'a ForegroundApp,
    ) -> PolishContext<'a> {
        PolishContext {
            raw,
            settings,
            dictionary,
            snippets,
            app,
            vibe: false,
            command_instruction: None,
            selection: None,
        }
    }

    fn offline_settings() -> Settings {
        let mut s = Settings::default();
        // No key and polish off: only the deterministic passes run.
        s.providers.openrouter_api_key = String::new();
        s.providers.polish_enabled = false;
        s
    }

    #[test]
    fn dictionary_replaces_whole_words_case_insensitively() {
        let d = vec![dict("Spechy", "speechy")];
        let (out, used, count) = apply_dictionary("Speechy and speechy, but speechyness stays", &d);
        assert_eq!(out, "Spechy and Spechy, but speechyness stays");
        assert_eq!(used, vec!["d-Spechy".to_string()]);
        assert_eq!(count, 2);
    }

    #[test]
    fn snippets_match_longest_first_and_tolerate_punctuation() {
        let s = vec![
            snip("s1", "sign off", "Best regards"),
            snip("s2", "sign off formally", "Kind regards, Remo"),
        ];
        let (out, used) = apply_snippets("sign off formally. And then sign off.", &s);
        assert_eq!(out, "Kind regards, Remo And then Best regards");
        assert!(used.contains(&"s1".to_string()));
        assert!(used.contains(&"s2".to_string()));
    }

    #[test]
    fn snippet_trigger_is_not_matched_inside_a_word() {
        let s = vec![snip("s1", "addr", "Hauptstrasse 1")];
        let (out, used) = apply_snippets("readdress the addr now", &s);
        assert_eq!(out, "readdress the Hauptstrasse 1 now");
        assert_eq!(used, vec!["s1".to_string()]);
    }

    #[test]
    fn polish_without_key_runs_deterministic_passes_only() {
        let settings = offline_settings();
        let dictionary = vec![dict("Tauri", "tori")];
        let snippets = vec![snip("s1", "my address", "Musterweg 3")];
        let app = ForegroundApp { process_name: "code.exe".into(), title: "src".into(), hwnd: 0 };
        let result = polish(ctx_for(
            "my address, built with tori",
            &settings,
            &dictionary,
            &snippets,
            &app,
        ))
        .unwrap();
        // The trailing comma of the trigger is swallowed with it.
        assert_eq!(result.text, "Musterweg 3 built with Tauri");
        assert_eq!(result.used_snippets, vec!["s1".to_string()]);
        assert_eq!(result.used_dictionary, vec!["d-Tauri".to_string()]);
    }

    #[test]
    fn polish_target_follows_the_chosen_provider() {
        let mut s = Settings::default();
        s.providers.openrouter_api_key = "sk-or-test".into();
        let t = polish_target(&s).unwrap();
        assert_eq!(t.base_url, OPENROUTER_BASE);
        assert!(t.openrouter);
        assert_eq!(t.model, "google/gemini-2.5-flash-lite");

        s.providers.polish_provider = "groq".into();
        assert!(polish_target(&s).is_err()); // no Groq key yet
        s.providers.groq_api_key = "gsk_test".into();
        let t = polish_target(&s).unwrap();
        assert_eq!(t.base_url, GROQ_BASE);
        assert_eq!(t.model, "llama-3.3-70b-versatile");
        assert!(!t.openrouter);

        s.providers.polish_provider = "custom".into();
        assert!(polish_target(&s).is_err()); // no address yet
        s.providers.custom_polish_base_url = "http://localhost:11434/v1".into();
        s.providers.custom_polish_model = "qwen2.5:7b".into();
        let t = polish_target(&s).unwrap();
        assert_eq!(t.base_url, "http://localhost:11434/v1");
        // A local server usually needs no key at all.
        assert!(t.api_key.is_empty());
    }

    #[test]
    fn strip_wrapping_removes_quotes_and_fences() {
        assert_eq!(strip_wrapping("\"hallo welt\""), "hallo welt");
        assert_eq!(strip_wrapping("```\nhallo welt\n```"), "hallo welt");
        assert_eq!(strip_wrapping("```text\nhallo welt\n```"), "hallo welt");
        assert_eq!(strip_wrapping("he said \"hi\" to me"), "he said \"hi\" to me");
        assert_eq!(strip_wrapping("  plain  "), "plain");
    }

    #[test]
    fn system_prompt_carries_tone_vocabulary_and_app_rule() {
        let mut settings = offline_settings();
        settings.style.app_rules.push(crate::model::AppStyleRule {
            id: "r1".into(),
            app_match: "slack".into(),
            tone: "casual".into(),
            note: "short messages".into(),
        });
        let dictionary = vec![dict("Spechy", "speechy")];
        let snippets = vec![snip("s1", "sign off", "Best regards")];
        let app = ForegroundApp { process_name: "slack.exe".into(), title: "Slack".into(), hwnd: 0 };
        let prompt = build_system_prompt(&ctx_for("x", &settings, &dictionary, &snippets, &app));
        assert!(prompt.contains("Tone: casual"));
        assert!(prompt.contains("short messages"));
        assert!(prompt.contains("Spechy"));
        assert!(prompt.contains("sign off"));
    }
}
