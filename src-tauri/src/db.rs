//! SQLite storage (rusqlite, bundled): history, dictionary, snippets, transforms, scratchpad.
//!
//! One global connection behind a Mutex; every function takes care of locking itself.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use rusqlite::{params, Connection};

use crate::model::{
    new_id, now_ms, AppStat, DayStat, DictationMode, DictionaryEntry, HistoryEntry, HistoryPage, Snippet, Stats,
    Transform, WordStat,
};

static CONN: OnceLock<Mutex<Connection>> = OnceLock::new();

fn conn() -> Result<std::sync::MutexGuard<'static, Connection>, String> {
    let cell = CONN.get().ok_or_else(|| "Database is not initialized".to_string())?;
    cell.lock().map_err(|_| "Database lock is poisoned".to_string())
}

fn mode_to_str(mode: DictationMode) -> &'static str {
    match mode {
        DictationMode::PushToTalk => "push-to-talk",
        DictationMode::HandsFree => "hands-free",
        DictationMode::Command => "command",
    }
}

fn mode_from_str(s: &str) -> DictationMode {
    match s {
        "hands-free" => DictationMode::HandsFree,
        "command" => DictationMode::Command,
        _ => DictationMode::PushToTalk,
    }
}

const BUILTIN_TRANSFORMS: [(&str, &str); 6] = [
    (
        "Organize thoughts",
        "Reorganize the text into a clear, well structured version. Keep the language of the input, keep every fact, group related thoughts, and output only the resulting text.",
    ),
    (
        "Make it concise",
        "Rewrite the text as concisely as possible without losing information. Keep the language of the input and output only the resulting text.",
    ),
    (
        "Turn into bullet points",
        "Turn the text into a compact bullet list. One idea per bullet, keep the language of the input, output only the list.",
    ),
    (
        "Fix grammar only",
        "Fix grammar, spelling and punctuation. Do not rephrase, do not change the wording or the language. Output only the corrected text.",
    ),
    (
        "Translate to English",
        "Translate the text into natural English. Keep the tone. Output only the translation.",
    ),
    (
        "Translate to German",
        "Translate the text into natural German. Keep the tone. Output only the translation.",
    ),
];

/// Open the database, create the schema and seed the builtin transforms once.
pub fn init() -> Result<(), String> {
    let path = crate::settings::data_dir().join("spechy.db");
    let c = Connection::open(&path).map_err(|e| format!("Could not open the database: {e}"))?;
    init_schema(&c)?;
    seed_transforms(&c)?;
    CONN.set(Mutex::new(c)).map_err(|_| "Database was already initialized".to_string())?;
    Ok(())
}

fn init_schema(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS history (
            id TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            text TEXT NOT NULL,
            raw_text TEXT NOT NULL,
            app_name TEXT NOT NULL,
            app_title TEXT NOT NULL,
            duration_ms INTEGER NOT NULL,
            latency_ms INTEGER NOT NULL,
            word_count INTEGER NOT NULL,
            flagged INTEGER NOT NULL DEFAULT 0,
            mode TEXT NOT NULL,
            fixes INTEGER NOT NULL DEFAULT 0,
            dictionary_fixes INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_history_created ON history(created_at DESC);
         CREATE TABLE IF NOT EXISTS dictionary (
            id TEXT PRIMARY KEY,
            word TEXT NOT NULL,
            misspelling TEXT NOT NULL DEFAULT '',
            auto_learned INTEGER NOT NULL DEFAULT 0,
            starred INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            uses INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS snippets (
            id TEXT PRIMARY KEY,
            trigger TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            uses INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS transforms (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL,
            builtin INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS scratchpad (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
         );",
    )
    .map_err(|e| format!("Could not create the database schema: {e}"))
}

fn seed_transforms(c: &Connection) -> Result<(), String> {
    let existing: i64 = c
        .query_row("SELECT COUNT(*) FROM transforms WHERE builtin = 1", [], |r| r.get(0))
        .map_err(|e| format!("Could not read the transforms table: {e}"))?;
    if existing > 0 {
        return Ok(());
    }
    let now = now_ms();
    for (i, (name, prompt)) in BUILTIN_TRANSFORMS.iter().enumerate() {
        c.execute(
            "INSERT INTO transforms (id, name, prompt, builtin, created_at) VALUES (?1, ?2, ?3, 1, ?4)",
            params![new_id(), name, prompt, now + i as i64],
        )
        .map_err(|e| format!("Could not seed the builtin transforms: {e}"))?;
    }
    Ok(())
}

// ---------- History ----------

/// Word-level edit distance between the raw transcript and the final text.
/// Used as the "fixes" counter in the stats view.
pub fn word_diff_count(raw: &str, text: &str) -> i64 {
    let a: Vec<&str> = raw.split_whitespace().collect();
    let b: Vec<&str> = text.split_whitespace().collect();
    if a.is_empty() {
        return b.len() as i64;
    }
    if b.is_empty() {
        return a.len() as i64;
    }
    // Levenshtein over word vectors, two-row rolling buffer.
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        for j in 1..=b.len() {
            let cost = if a[i - 1].eq_ignore_ascii_case(b[j - 1]) { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()] as i64
}

/// Insert a finished dictation. `dictionary_fixes` is passed through the entry's
/// caller via `insert_history_with_fixes`; this variant computes the word diff only.
pub fn insert_history(e: &HistoryEntry) -> Result<(), String> {
    insert_history_with_fixes(e, 0)
}

/// Insert a finished dictation together with the number of dictionary replacements applied.
pub fn insert_history_with_fixes(e: &HistoryEntry, dictionary_fixes: i64) -> Result<(), String> {
    let fixes = word_diff_count(&e.raw_text, &e.text);
    let c = conn()?;
    c.execute(
        "INSERT OR REPLACE INTO history
         (id, created_at, text, raw_text, app_name, app_title, duration_ms, latency_ms, word_count, flagged, mode, fixes, dictionary_fixes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            e.id,
            e.created_at,
            e.text,
            e.raw_text,
            e.app_name,
            e.app_title,
            e.duration_ms,
            e.latency_ms,
            e.word_count,
            e.flagged as i64,
            mode_to_str(e.mode),
            fixes,
            dictionary_fixes,
        ],
    )
    .map_err(|e| format!("Could not save the dictation: {e}"))?;
    Ok(())
}

fn row_to_history(row: &rusqlite::Row) -> rusqlite::Result<HistoryEntry> {
    let mode: String = row.get("mode")?;
    let flagged: i64 = row.get("flagged")?;
    Ok(HistoryEntry {
        id: row.get("id")?,
        created_at: row.get("created_at")?,
        text: row.get("text")?,
        raw_text: row.get("raw_text")?,
        app_name: row.get("app_name")?,
        app_title: row.get("app_title")?,
        duration_ms: row.get("duration_ms")?,
        latency_ms: row.get("latency_ms")?,
        word_count: row.get("word_count")?,
        flagged: flagged != 0,
        mode: mode_from_str(&mode),
    })
}

pub fn list_history(limit: i64, offset: i64, query: &str) -> Result<HistoryPage, String> {
    let c = conn()?;
    let q = query.trim();
    let (total, entries) = if q.is_empty() {
        let total: i64 = c
            .query_row("SELECT COUNT(*) FROM history", [], |r| r.get(0))
            .map_err(|e| format!("Could not count the history: {e}"))?;
        let mut stmt = c
            .prepare("SELECT * FROM history ORDER BY created_at DESC LIMIT ?1 OFFSET ?2")
            .map_err(|e| format!("Could not read the history: {e}"))?;
        let rows = stmt
            .query_map(params![limit, offset], row_to_history)
            .map_err(|e| format!("Could not read the history: {e}"))?;
        let entries: Vec<HistoryEntry> = rows.filter_map(|r| r.ok()).collect();
        (total, entries)
    } else {
        let like = format!("%{}%", q);
        let total: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM history WHERE text LIKE ?1 OR app_name LIKE ?1 OR app_title LIKE ?1",
                params![like],
                |r| r.get(0),
            )
            .map_err(|e| format!("Could not count the history: {e}"))?;
        let mut stmt = c
            .prepare(
                "SELECT * FROM history WHERE text LIKE ?1 OR app_name LIKE ?1 OR app_title LIKE ?1
                 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3",
            )
            .map_err(|e| format!("Could not read the history: {e}"))?;
        let rows = stmt
            .query_map(params![like, limit, offset], row_to_history)
            .map_err(|e| format!("Could not read the history: {e}"))?;
        let entries: Vec<HistoryEntry> = rows.filter_map(|r| r.ok()).collect();
        (total, entries)
    };
    Ok(HistoryPage { entries, total })
}

pub fn get_history(id: &str) -> Result<HistoryEntry, String> {
    let c = conn()?;
    c.query_row("SELECT * FROM history WHERE id = ?1", params![id], row_to_history)
        .map_err(|e| format!("Could not find that dictation: {e}"))
}

pub fn delete_history(id: &str) -> Result<(), String> {
    let c = conn()?;
    c.execute("DELETE FROM history WHERE id = ?1", params![id])
        .map_err(|e| format!("Could not delete the dictation: {e}"))?;
    Ok(())
}

pub fn set_history_flag(id: &str, flagged: bool) -> Result<(), String> {
    let c = conn()?;
    c.execute("UPDATE history SET flagged = ?2 WHERE id = ?1", params![id, flagged as i64])
        .map_err(|e| format!("Could not flag the dictation: {e}"))?;
    Ok(())
}

pub fn update_history_text(id: &str, text: &str) -> Result<(), String> {
    let c = conn()?;
    let raw: String = c
        .query_row("SELECT raw_text FROM history WHERE id = ?1", params![id], |r| r.get(0))
        .map_err(|e| format!("Could not find that dictation: {e}"))?;
    let word_count = text.split_whitespace().count() as i64;
    let fixes = word_diff_count(&raw, text);
    c.execute(
        "UPDATE history SET text = ?2, word_count = ?3, fixes = ?4 WHERE id = ?1",
        params![id, text, word_count, fixes],
    )
    .map_err(|e| format!("Could not update the dictation: {e}"))?;
    Ok(())
}

pub fn clear_history() -> Result<(), String> {
    let c = conn()?;
    c.execute("DELETE FROM history", [])
        .map_err(|e| format!("Could not clear the history: {e}"))?;
    Ok(())
}

// ---------- Dictionary ----------

pub fn list_dictionary() -> Result<Vec<DictionaryEntry>, String> {
    let c = conn()?;
    let mut stmt = c
        .prepare("SELECT * FROM dictionary ORDER BY starred DESC, uses DESC, word COLLATE NOCASE ASC")
        .map_err(|e| format!("Could not read the dictionary: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            let auto: i64 = row.get("auto_learned")?;
            let starred: i64 = row.get("starred")?;
            Ok(DictionaryEntry {
                id: row.get("id")?,
                word: row.get("word")?,
                misspelling: row.get("misspelling")?,
                auto_learned: auto != 0,
                starred: starred != 0,
                created_at: row.get("created_at")?,
                uses: row.get("uses")?,
            })
        })
        .map_err(|e| format!("Could not read the dictionary: {e}"))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn upsert_dictionary(e: &DictionaryEntry) -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "INSERT INTO dictionary (id, word, misspelling, auto_learned, starred, created_at, uses)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET word = ?2, misspelling = ?3, auto_learned = ?4, starred = ?5",
        params![
            e.id,
            e.word,
            e.misspelling,
            e.auto_learned as i64,
            e.starred as i64,
            e.created_at,
            e.uses
        ],
    )
    .map_err(|e| format!("Could not save the dictionary entry: {e}"))?;
    Ok(())
}

pub fn delete_dictionary(id: &str) -> Result<(), String> {
    let c = conn()?;
    c.execute("DELETE FROM dictionary WHERE id = ?1", params![id])
        .map_err(|e| format!("Could not delete the dictionary entry: {e}"))?;
    Ok(())
}

pub fn bump_dictionary_uses(ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let c = conn()?;
    for id in ids {
        let _ = c.execute("UPDATE dictionary SET uses = uses + 1 WHERE id = ?1", params![id]);
    }
    Ok(())
}

// ---------- Snippets ----------

pub fn list_snippets() -> Result<Vec<Snippet>, String> {
    let c = conn()?;
    let mut stmt = c
        .prepare("SELECT * FROM snippets ORDER BY uses DESC, trigger COLLATE NOCASE ASC")
        .map_err(|e| format!("Could not read the snippets: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Snippet {
                id: row.get("id")?,
                trigger: row.get("trigger")?,
                text: row.get("text")?,
                created_at: row.get("created_at")?,
                uses: row.get("uses")?,
            })
        })
        .map_err(|e| format!("Could not read the snippets: {e}"))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn upsert_snippet(s: &Snippet) -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "INSERT INTO snippets (id, trigger, text, created_at, uses) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET trigger = ?2, text = ?3",
        params![s.id, s.trigger, s.text, s.created_at, s.uses],
    )
    .map_err(|e| format!("Could not save the snippet: {e}"))?;
    Ok(())
}

pub fn delete_snippet(id: &str) -> Result<(), String> {
    let c = conn()?;
    c.execute("DELETE FROM snippets WHERE id = ?1", params![id])
        .map_err(|e| format!("Could not delete the snippet: {e}"))?;
    Ok(())
}

pub fn bump_snippet_uses(ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let c = conn()?;
    for id in ids {
        let _ = c.execute("UPDATE snippets SET uses = uses + 1 WHERE id = ?1", params![id]);
    }
    Ok(())
}

// ---------- Transforms ----------

pub fn list_transforms() -> Result<Vec<Transform>, String> {
    let c = conn()?;
    let mut stmt = c
        .prepare("SELECT * FROM transforms ORDER BY builtin DESC, created_at ASC")
        .map_err(|e| format!("Could not read the transforms: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            let builtin: i64 = row.get("builtin")?;
            Ok(Transform {
                id: row.get("id")?,
                name: row.get("name")?,
                prompt: row.get("prompt")?,
                builtin: builtin != 0,
                created_at: row.get("created_at")?,
            })
        })
        .map_err(|e| format!("Could not read the transforms: {e}"))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn upsert_transform(t: &Transform) -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "INSERT INTO transforms (id, name, prompt, builtin, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET name = ?2, prompt = ?3",
        params![t.id, t.name, t.prompt, t.builtin as i64, t.created_at],
    )
    .map_err(|e| format!("Could not save the transform: {e}"))?;
    Ok(())
}

pub fn delete_transform(id: &str) -> Result<(), String> {
    let c = conn()?;
    c.execute("DELETE FROM transforms WHERE id = ?1", params![id])
        .map_err(|e| format!("Could not delete the transform: {e}"))?;
    Ok(())
}

pub fn get_transform(id: &str) -> Result<Transform, String> {
    list_transforms()?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| "That transform does not exist".to_string())
}

// ---------- Scratchpad ----------

pub fn get_scratchpad() -> Result<String, String> {
    let c = conn()?;
    let value: Option<String> = c
        .query_row("SELECT value FROM scratchpad WHERE key = 'text'", [], |r| r.get(0))
        .ok();
    Ok(value.unwrap_or_default())
}

pub fn set_scratchpad(text: &str) -> Result<(), String> {
    let c = conn()?;
    c.execute(
        "INSERT INTO scratchpad (key, value) VALUES ('text', ?1)
         ON CONFLICT(key) DO UPDATE SET value = ?1",
        params![text],
    )
    .map_err(|e| format!("Could not save the scratchpad: {e}"))?;
    Ok(())
}

// ---------- Stats ----------

const STOPWORDS: &[&str] = &[
    "aber", "aller", "alles", "also", "andere", "auch", "auf", "aus", "bei", "beim", "dann", "dass", "dein", "denn",
    "der", "des", "dich", "die", "dies", "diese", "doch", "dort", "durch", "eine", "einem", "einen", "einer", "eines",
    "etwa", "euch", "fuer", "ganz", "gegen", "habe", "haben", "hier", "ihre", "immer", "kann", "mehr", "mein", "mich",
    "mist", "nach", "nicht", "noch", "nur", "oder", "ohne", "schon", "sehr", "sein", "sich", "sind", "sondern", "ueber",
    "und", "vom", "von", "wenn", "werden", "wie", "wird", "about", "after", "also", "been", "before", "from", "have",
    "into", "just", "like", "only", "some", "than", "that", "them", "then", "there", "they", "this", "very", "were",
    "what", "when", "will", "with", "your",
];

/// Median of a sorted-able list of f64 values.
fn median(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    }
}

/// Streak of consecutive days with at least one dictation, ending today or yesterday.
fn current_streak(days: &[String], today: chrono::NaiveDate) -> i64 {
    use std::collections::HashSet;
    let set: HashSet<&String> = days.iter().collect();
    let mut cursor = today;
    let today_key = today.format("%Y-%m-%d").to_string();
    let yesterday_key = (today - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
    if !set.contains(&today_key) {
        if !set.contains(&yesterday_key) {
            return 0;
        }
        cursor = today - chrono::Duration::days(1);
    }
    let mut streak = 0i64;
    loop {
        let key = cursor.format("%Y-%m-%d").to_string();
        if !set.contains(&key) {
            break;
        }
        streak += 1;
        cursor -= chrono::Duration::days(1);
    }
    streak
}

fn longest_streak(days: &mut Vec<String>) -> i64 {
    days.sort();
    days.dedup();
    let mut best = 0i64;
    let mut run = 0i64;
    let mut prev: Option<chrono::NaiveDate> = None;
    for d in days.iter() {
        let Ok(date) = chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d") else { continue };
        run = match prev {
            Some(p) if date == p + chrono::Duration::days(1) => run + 1,
            _ => 1,
        };
        best = best.max(run);
        prev = Some(date);
    }
    best
}

pub fn stats() -> Result<Stats, String> {
    let guard = conn()?;
    stats_with(&guard)
}

/// The stats query, split out so the unit tests can run it on an in-memory database.
fn stats_with(c: &Connection) -> Result<Stats, String> {
    let mut s = Stats::default();

    let (total_words, total_dictations, fixes, dictionary_fixes): (i64, i64, i64, i64) = c
        .query_row(
            "SELECT COALESCE(SUM(word_count), 0), COUNT(*), COALESCE(SUM(fixes), 0), COALESCE(SUM(dictionary_fixes), 0) FROM history",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| format!("Could not read the statistics: {e}"))?;
    s.total_words = total_words;
    s.total_dictations = total_dictations;
    s.fixes = fixes;
    s.dictionary_fixes = dictionary_fixes;

    // wpm: median over the last 50 entries with a usable duration.
    let mut stmt = c
        .prepare("SELECT word_count, duration_ms FROM history ORDER BY created_at DESC LIMIT 50")
        .map_err(|e| format!("Could not read the statistics: {e}"))?;
    let rates: Vec<f64> = stmt
        .query_map([], |r| {
            let words: i64 = r.get(0)?;
            let duration: i64 = r.get(1)?;
            Ok((words, duration))
        })
        .map_err(|e| format!("Could not read the statistics: {e}"))?
        .filter_map(|r| r.ok())
        .filter(|(words, duration)| *duration > 500 && *words > 0)
        .map(|(words, duration)| words as f64 / (duration as f64 / 60000.0))
        .collect();
    s.wpm = median(rates).round() as i64;

    // per_day over the last 365 days (only days with data).
    let cutoff = now_ms() - 365 * 24 * 3600 * 1000;
    let mut stmt = c
        .prepare(
            "SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
                    COALESCE(SUM(word_count), 0), COUNT(*)
             FROM history WHERE created_at >= ?1 GROUP BY day ORDER BY day ASC",
        )
        .map_err(|e| format!("Could not read the statistics: {e}"))?;
    let per_day: Vec<DayStat> = stmt
        .query_map(params![cutoff], |r| {
            Ok(DayStat { date: r.get(0)?, words: r.get(1)?, count: r.get(2)? })
        })
        .map_err(|e| format!("Could not read the statistics: {e}"))?
        .filter_map(|r| r.ok())
        .filter(|d| d.count > 0)
        .collect();

    let mut days: Vec<String> = c.prepare(
        "SELECT DISTINCT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') FROM history ORDER BY 1"
    ).map_err(|e| e.to_string())?
        .query_map([], |r| r.get(0)).map_err(|e| e.to_string())?
        .collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    s.streak_days = current_streak(&days, chrono::Local::now().date_naive());
    s.longest_streak = longest_streak(&mut days);
    s.per_day = per_day;

    // Month sums (local time).
    let now = chrono::Local::now().naive_local();
    let this_month = now.format("%Y-%m").to_string();
    let prev_month = {
        let (y, m) = (now.date().format("%Y").to_string(), now.date().format("%m").to_string());
        let y: i32 = y.parse().unwrap_or(2026);
        let m: u32 = m.parse().unwrap_or(1);
        if m == 1 {
            format!("{:04}-12", y - 1)
        } else {
            format!("{:04}-{:02}", y, m - 1)
        }
    };
    let mut stmt = c
        .prepare(
            "SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch', 'localtime') AS month,
                    COALESCE(SUM(word_count), 0) FROM history GROUP BY month",
        )
        .map_err(|e| format!("Could not read the statistics: {e}"))?;
    let months: HashMap<String, i64> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| format!("Could not read the statistics: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    s.words_this_month = *months.get(&this_month).unwrap_or(&0);
    s.words_prev_month = *months.get(&prev_month).unwrap_or(&0);

    // per_app
    let mut stmt = c
        .prepare(
            "SELECT app_name, COALESCE(SUM(word_count), 0), COUNT(*), app_title FROM history
             WHERE app_name <> '' GROUP BY app_name, app_title ORDER BY 2 DESC",
        )
        .map_err(|e| format!("Could not read the statistics: {e}"))?;
    let per_app: Vec<AppStat> = stmt
        .query_map([], |r| {
            let app_name: String = r.get(0)?;
            let words: i64 = r.get(1)?;
            let count: i64 = r.get(2)?;
            Ok(AppStat {
                category: crate::winutil::app_category(&app_name, &r.get::<_, String>(3)?).to_string(),
                app_name,
                words,
                count,
            })
        })
        .map_err(|e| format!("Could not read the statistics: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    s.apps_used = per_app.iter().map(|a| &a.app_name).collect::<std::collections::HashSet<_>>().len() as i64;
    let mut grouped: HashMap<(String, String), AppStat> = HashMap::new();
    for row in per_app {
        let key = (row.app_name.clone(), row.category.clone());
        let entry = grouped.entry(key).or_insert_with(|| AppStat {
            app_name: row.app_name, category: row.category, ..Default::default()
        });
        entry.words += row.words;
        entry.count += row.count;
    }
    s.per_app = grouped.into_values().collect();
    s.per_app.sort_by(|a, b| b.words.cmp(&a.words).then_with(|| a.app_name.cmp(&b.app_name)).then_with(|| a.category.cmp(&b.category)));

    // top_words
    let mut stmt = c
        .prepare("SELECT text FROM history ORDER BY created_at DESC LIMIT 2000")
        .map_err(|e| format!("Could not read the statistics: {e}"))?;
    let texts: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| format!("Could not read the statistics: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    let mut counts: HashMap<String, i64> = HashMap::new();
    for text in texts {
        for token in text.split(|ch: char| !ch.is_alphanumeric() && ch != '\'' && ch != '-') {
            let word = token.to_lowercase();
            if word.chars().count() <= 3 || STOPWORDS.contains(&word.as_str()) {
                continue;
            }
            *counts.entry(word).or_insert(0) += 1;
        }
    }
    let mut top: Vec<WordStat> = counts.into_iter().map(|(word, count)| WordStat { word, count }).collect();
    top.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.word.cmp(&b.word)));
    top.truncate(30);
    s.top_words = top;

    Ok(s)
}

/// The whole database as one JSON string (used by the export command).
pub fn export_json() -> Result<String, String> {
    let page = list_history(1_000_000, 0, "")?;
    let mut settings = crate::settings::current();
    settings.providers.groq_api_key.clear();
    settings.providers.openrouter_api_key.clear();
    settings.providers.custom_stt_api_key.clear();
    settings.providers.custom_polish_api_key.clear();
    let value = serde_json::json!({
        "exportedAt": now_ms(),
        "settings": settings,
        "history": page.entries,
        "dictionary": list_dictionary()?,
        "snippets": list_snippets()?,
        "transforms": list_transforms()?,
        "scratchpad": get_scratchpad()?,
    });
    serde_json::to_string_pretty(&value).map_err(|e| format!("Could not build the export: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init_schema(&c).unwrap();
        c
    }

    fn insert(c: &Connection, id: &str, created_at: i64, words: i64, duration: i64, app: &str, text: &str) {
        c.execute(
            "INSERT INTO history (id, created_at, text, raw_text, app_name, app_title, duration_ms, latency_ms,
             word_count, flagged, mode, fixes, dictionary_fixes)
             VALUES (?1, ?2, ?3, ?3, ?4, '', ?5, 100, ?6, 0, 'push-to-talk', 2, 1)",
            params![id, created_at, text, app, duration, words],
        )
        .unwrap();
    }

    #[test]
    fn stats_on_empty_db_are_zero() {
        let c = memory_db();
        let s = stats_with(&c).unwrap();
        assert_eq!(s.total_dictations, 0);
        assert_eq!(s.total_words, 0);
        assert_eq!(s.wpm, 0);
        assert_eq!(s.streak_days, 0);
        assert!(s.per_day.is_empty());
    }

    #[test]
    fn stats_aggregate_words_apps_and_fixes() {
        let c = memory_db();
        let now = now_ms();
        insert(&c, "a", now, 60, 60_000, "code.exe", "hallo welt dictation dictation");
        insert(&c, "b", now - 1000, 30, 60_000, "slack.exe", "dictation testing testing");
        let s = stats_with(&c).unwrap();
        assert_eq!(s.total_dictations, 2);
        assert_eq!(s.total_words, 90);
        assert_eq!(s.fixes, 4);
        assert_eq!(s.dictionary_fixes, 2);
        assert_eq!(s.apps_used, 2);
        // Median of 60 wpm and 30 wpm.
        assert_eq!(s.wpm, 45);
        assert_eq!(s.streak_days, 1);
        assert_eq!(s.per_day.len(), 1);
        let top = s.top_words.iter().find(|w| w.word == "dictation").unwrap();
        assert_eq!(top.count, 3);
        assert!(s.top_words.iter().all(|w| w.word.chars().count() > 3));
    }

    #[test]
    fn streaks_count_consecutive_days() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 9, 13).unwrap();
        let days = vec![
            "2026-09-01".to_string(),
            "2026-09-02".to_string(),
            "2026-09-03".to_string(),
            "2026-09-12".to_string(),
            "2026-09-13".to_string(),
        ];
        assert_eq!(current_streak(&days, today), 2);
        assert_eq!(longest_streak(&mut days.clone()), 3);
        // A gap of more than one day ends the streak.
        let stale = vec!["2026-09-01".to_string()];
        assert_eq!(current_streak(&stale, today), 0);
    }

    #[test]
    fn word_diff_counts_changed_words() {
        assert_eq!(word_diff_count("", ""), 0);
        assert_eq!(word_diff_count("hallo welt", "hallo welt"), 0);
        assert_eq!(word_diff_count("hallo welt", "hallo schoene welt"), 1);
        assert_eq!(word_diff_count("aeh hallo welt", "hallo welt"), 1);
    }

    #[test]
    fn browser_categories_use_the_recorded_title_without_double_counting_apps() {
        let c = memory_db();
        insert(&c, "mail", now_ms(), 10, 6000, "chrome.exe", "hello");
        insert(&c, "ai", now_ms(), 20, 6000, "chrome.exe", "hello");
        c.execute("UPDATE history SET app_title = 'Gmail' WHERE id = 'mail'", []).unwrap();
        c.execute("UPDATE history SET app_title = 'ChatGPT' WHERE id = 'ai'", []).unwrap();
        let s = stats_with(&c).unwrap();
        assert_eq!(s.apps_used, 1);
        assert_eq!(s.per_app.len(), 2);
        assert!(s.per_app.iter().any(|a| a.category == "email" && a.words == 10));
        assert!(s.per_app.iter().any(|a| a.category == "ai" && a.words == 20));
    }

    #[test]
    fn longest_streak_includes_history_older_than_heatmap() {
        let c = memory_db();
        let old = now_ms() - 400 * 86_400_000;
        for i in 0..3 {
            insert(&c, &i.to_string(), old + i * 86_400_000, 10, 6000, "code.exe", "hello");
        }
        let s = stats_with(&c).unwrap();
        assert_eq!(s.longest_streak, 3);
        assert!(s.per_day.is_empty());
    }
}
