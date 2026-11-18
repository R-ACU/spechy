//! Client for the opt-in weekly leaderboard (server: `server/leaderboard/`, API in its README.md).
//!
//! Ground rules (AGENTS.md, CLIENT.md):
//! - Before the player joins this module never opens a connection: every command checks the
//!   local state first, `status` is purely local, and nothing runs in the background.
//! - Only name, title, rank, weekly points, words and game bests leave the device, never text.
//! - Leaving deletes everything on the server (`DELETE /v1/me`), then the local account file.
//! - The token lives in `leaderboard.json` in the data folder, never in `settings.json`, never in
//!   the data export (`db::export_json` reads settings and the database only), never in logs.
//! - All requests go through Rust (no WebView fetch, so no CORS and no token in JavaScript).
//!   The sync runs on one background worker; failures are silent and retried with the same
//!   `batchId`, so a game or a dictation is never blocked or counted twice.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const EV_LEADERBOARD_CHANGED: &str = "spechy://leaderboard-changed";

/// Server limits mirrored from `server/leaderboard/src/limits.ts`.
const MAX_POINTS_PER_BATCH: i64 = 5_000;
const MAX_WORDS_PER_BATCH: i64 = 20_000;
const MAX_GAMES_PER_BATCH: usize = 20;
const AVATAR_MAX_BYTES: usize = 256 * 1024;
const AVATAR_MIN_SIDE: u32 = 32;
const AVATAR_MAX_SIDE: u32 = 1024;
const DEBUG_DEFAULT_URL: &str = "http://127.0.0.1:8787";
const CATEGORIES: [&str; 5] = ["overall", "words", "tower", "snake", "comet"];

static REQUESTS: AtomicU64 = AtomicU64::new(0);

/// How many requests this process has sent to a leaderboard server (zero until the player joins).
pub fn request_count() -> u64 {
    REQUESTS.load(Ordering::Relaxed)
}

// ---------------------------------------------------------------- errors

/// What a command rejects with. The page gets this object as the rejection value.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LbError {
    /// Server code (`validation_failed`, `rate_limited`, ...) or local: `network`, `not_configured`,
    /// `not_joined`, `already_joined`, `locked`, `invalid`.
    pub code: String,
    pub message: String,
    /// `length` | `characters` | `profanity` | `reserved` for a rejected name.
    pub reason: Option<String>,
    /// Seconds, from `Retry-After`.
    pub retry_after: Option<u64>,
    pub status: u16,
}

impl LbError {
    fn local(code: &str, message: &str) -> Self {
        Self { code: code.into(), message: message.into(), reason: None, retry_after: None, status: 0 }
    }
    /// Worth trying again later with the same batch.
    fn retryable(&self) -> bool {
        self.code == "network" || self.status >= 500 || self.status == 429 || self.status == 408
    }
}

impl From<String> for LbError {
    fn from(message: String) -> Self {
        Self::local("invalid", &message)
    }
}

// ---------------------------------------------------------------- persisted state

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
struct Outbox {
    points: i64,
    words: i64,
    /// Best score per game since the last successful batch (the server keeps weekly bests only).
    games: BTreeMap<String, i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct Batch {
    #[serde(rename = "batchId")]
    batch_id: String,
    points: i64,
    words: i64,
    games: Vec<(String, i64)>,
}

impl Outbox {
    fn is_empty(&self) -> bool {
        self.points == 0 && self.words == 0 && self.games.is_empty()
    }

    /// Move up to one request's worth out of the outbox into a new batch with a fresh id.
    fn take_batch(&mut self) -> Option<Batch> {
        if self.is_empty() {
            return None;
        }
        let points = self.points.min(MAX_POINTS_PER_BATCH);
        let words = self.words.min(MAX_WORDS_PER_BATCH);
        self.points -= points;
        self.words -= words;
        let mut games = vec![];
        while games.len() < MAX_GAMES_PER_BATCH {
            let Some(key) = self.games.keys().next().cloned() else { break };
            if let Some(score) = self.games.remove(&key) {
                games.push((key, score));
            }
        }
        Some(Batch { batch_id: uuid::Uuid::new_v4().to_string(), points, words, games })
    }
}

/// Rank and title as the server knows them.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct Profile {
    #[serde(rename = "titleId")]
    title_id: Option<String>,
    tier: i64,
    division: i64,
    rp: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct Account {
    base_url: String,
    player_id: String,
    token: String,
    display_name: String,
    /// The player left, the server has not confirmed the deletion yet. No other call is made.
    pending_leave: bool,
    outbox: Outbox,
    inflight: Option<Batch>,
    last_profile: Option<Profile>,
    avatar_pending: bool,
    /// The player removed the picture while the server could not be reached: `DELETE /v1/me/avatar` is retried.
    avatar_delete_pending: bool,
    /// Current ISO week ("2026-W47") for which `lastWeek` was already read: one `GET /v1/me` a week.
    payout_checked: String,
    hidden: bool,
    avatar_hidden: bool,
}

impl Default for Account {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            player_id: String::new(),
            token: String::new(),
            display_name: String::new(),
            pending_leave: false,
            outbox: Outbox::default(),
            inflight: None,
            last_profile: None,
            avatar_pending: false,
            avatar_delete_pending: false,
            payout_checked: String::new(),
            hidden: false,
            avatar_hidden: false,
        }
    }
}

// No derive(Debug) on Account on purpose: the token must never reach a log by accident.

fn account_path() -> PathBuf {
    crate::settings::data_dir().join("leaderboard.json")
}

fn load_account() -> Option<Account> {
    let raw = std::fs::read_to_string(account_path()).ok()?;
    let acc: Account = serde_json::from_str(&raw).ok()?;
    if acc.token.is_empty() || acc.base_url.is_empty() {
        return None;
    }
    Some(acc)
}

fn write_account(acc: &Account) {
    let path = account_path();
    let tmp = path.with_extension("json.tmp");
    let Ok(json) = serde_json::to_string_pretty(acc) else { return };
    if std::fs::write(&tmp, json).is_err() {
        log::warn!("leaderboard: account file could not be written");
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        log::warn!("leaderboard: account file could not be replaced");
    }
}

/// `None` outside = not loaded yet; `Some(None)` = loaded, not joined.
static STATE: Mutex<Option<Option<Account>>> = Mutex::new(None);

/// Run `f` on the account (if any) and persist the result. Returns `None` when not joined.
fn with_account<R>(f: impl FnOnce(&mut Account) -> R) -> Option<R> {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let slot = guard.get_or_insert_with(load_account);
    let acc = slot.as_mut()?;
    let out = f(acc);
    write_account(acc);
    Some(out)
}

fn read_account<R>(f: impl FnOnce(&Account) -> R) -> Option<R> {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let slot = guard.get_or_insert_with(load_account);
    slot.as_ref().map(f)
}

fn set_account(acc: Option<Account>) {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    match &acc {
        Some(a) => write_account(a),
        None => {
            let _ = std::fs::remove_file(account_path());
        }
    }
    *guard = Some(acc);
}

/// True once the player has joined and not left.
pub fn is_joined() -> bool {
    read_account(|a| !a.pending_leave).unwrap_or(false)
}

// ---------------------------------------------------------------- base url

/// https anywhere, http only for the local machine (the token must never travel in clear text).
fn valid_base(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/');
    let rest = url.strip_prefix("https://").map(|r| (true, r)).or_else(|| url.strip_prefix("http://").map(|r| (false, r)))?;
    let (secure, rest) = rest;
    let host = rest.split(['/', ':']).next().unwrap_or("");
    if host.is_empty() || rest.contains(char::is_whitespace) {
        return None;
    }
    if secure || matches!(host, "localhost" | "127.0.0.1" | "[::1]") {
        Some(url.to_string())
    } else {
        None
    }
}

/// Setting `leaderboardUrl`; empty means the debug default in debug builds and "no server" in release.
fn configured_base() -> Option<String> {
    let setting = crate::settings::current().leaderboard_url;
    let chosen = if setting.trim().is_empty() {
        if cfg!(debug_assertions) { DEBUG_DEFAULT_URL.to_string() } else { String::new() }
    } else {
        setting
    };
    valid_base(&chosen)
}

// ---------------------------------------------------------------- http

enum Body<'a> {
    None,
    Json(Value),
    Bytes(&'a [u8], &'a str),
}

#[derive(Debug)]
struct Resp {
    body: Vec<u8>,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(15))
        .timeout_write(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .redirects(0)
        .user_agent("Spechy-leaderboard")
        .build()
}

fn request(base: &str, method: &str, path: &str, token: Option<&str>, body: Body) -> Result<Resp, LbError> {
    let url = format!("{base}{path}");
    REQUESTS.fetch_add(1, Ordering::Relaxed);
    // Path only (ids are public), never headers or bodies.
    log::info!("leaderboard: {method} {}", path.split('?').next().unwrap_or(path));
    let mut req = agent().request(method, &url);
    if let Some(t) = token {
        req = req.set("Authorization", &format!("Bearer {t}"));
    }
    let result = match body {
        Body::None => req.call(),
        Body::Json(v) => req.send_json(v),
        Body::Bytes(b, mime) => req.set("Content-Type", mime).send_bytes(b),
    };
    let response = match result {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(ureq::Error::Transport(_)) => {
            return Err(LbError::local("network", "Could not reach the leaderboard. Check your connection and try again."));
        }
    };
    let status = response.status();
    let retry_after = response.header("retry-after").and_then(|v| v.trim().parse::<u64>().ok());
    let mut bytes = vec![];
    let _ = response.into_reader().take(2 * 1024 * 1024).read_to_end(&mut bytes);
    if (200..300).contains(&status) {
        Ok(Resp { body: bytes })
    } else {
        Err(error_from(status, &bytes, retry_after))
    }
}

fn error_from(status: u16, body: &[u8], retry_after: Option<u64>) -> LbError {
    let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let e = &v["error"];
    let code = e["code"].as_str().map(str::to_string).unwrap_or_else(|| format!("http_{status}"));
    let message = e["message"].as_str().map(str::to_string).unwrap_or_else(|| format!("The leaderboard answered with status {status}."));
    let reason = e["details"]["reason"].as_str().map(str::to_string);
    LbError { code, message, reason, retry_after, status }
}

struct Session {
    base: String,
    token: String,
}

fn session() -> Result<Session, LbError> {
    read_account(|a| {
        if a.pending_leave {
            None
        } else {
            Some(Session { base: a.base_url.clone(), token: a.token.clone() })
        }
    })
    .flatten()
    .ok_or_else(|| LbError::local("not_joined", "Join the leaderboard first."))
}

/// An authenticated call. A 401 means the account is gone: forget it and stop every call.
fn authed(method: &str, path: &str, body: Body) -> Result<Resp, LbError> {
    let s = session()?;
    let out = request(&s.base, method, path, Some(&s.token), body);
    if let Err(e) = &out {
        if e.status == 401 {
            let same = read_account(|a| a.token == s.token).unwrap_or(false);
            if same {
                log::info!("leaderboard: account is gone on the server, local account removed");
                set_account(None);
                emit_changed();
            }
        }
    }
    out
}

fn emit_changed() {
    if let Some(app) = crate::pipeline::app_handle() {
        use tauri::Emitter;
        let _ = app.emit(EV_LEADERBOARD_CHANGED, status_now());
    }
}

// ---------------------------------------------------------------- status

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub joined: bool,
    pub server_configured: bool,
    pub display_name: Option<String>,
    pub player_id: Option<String>,
    /// Moderation hid the player (`hidden`) or the picture (`avatarHidden`).
    pub hidden: bool,
    pub avatar_hidden: bool,
}

/// Purely local: reads the settings and the account file, never the network.
pub fn status_now() -> Status {
    let joined = read_account(|a| (!a.pending_leave).then(|| (a.display_name.clone(), a.player_id.clone(), a.hidden, a.avatar_hidden))).flatten();
    let (display_name, player_id, hidden, avatar_hidden) = match joined.clone() {
        Some((n, p, h, ah)) => (Some(n), Some(p), h, ah),
        None => (None, None, false, false),
    };
    Status {
        joined: joined.is_some(),
        server_configured: joined.is_some() || configured_base().is_some(),
        display_name,
        player_id,
        hidden,
        avatar_hidden,
    }
}

// ---------------------------------------------------------------- profile from the economy

/// "Night Owl" -> "night-owl"; matches the server pattern `^[a-z0-9][a-z0-9_-]{0,31}$`.
pub fn title_slug(title: &str) -> Option<String> {
    let mut out = String::new();
    let mut dash = false;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            dash = true;
        }
    }
    out.truncate(32);
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() { None } else { Some(out) }
}

fn profile_from(state: &crate::economy::EconomyState) -> Profile {
    Profile {
        title_id: state.equipped.get("title").and_then(|t| title_slug(t)),
        tier: state.rank.tier.clamp(0, 6),
        division: state.rank.division.unwrap_or(0).clamp(0, 2),
        rp: state.rank.rp.clamp(0, 100),
    }
}

fn current_profile() -> Option<Profile> {
    crate::economy::economy_state().ok().map(|s| profile_from(&s))
}

// ---------------------------------------------------------------- join / leave

fn clean_name(name: &str) -> String {
    name.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn join(display_name: &str) -> Result<Status, LbError> {
    let base = configured_base().ok_or_else(|| LbError::local("not_configured", "The leaderboard server is not available in this build."))?;
    // An unfinished leave comes first: the old account must be gone before a new one exists.
    if read_account(|a| a.pending_leave).unwrap_or(false) {
        finish_pending_leave().map_err(|_| LbError::local("network", "Your previous leaderboard account is still being removed. Try again in a moment."))?;
    }
    if read_account(|_| ()).is_some() {
        return Err(LbError::local("already_joined", "You already joined the leaderboard."));
    }
    let name = clean_name(display_name);
    let profile = current_profile();
    let mut payload = json!({ "name": name });
    if let Some(p) = &profile {
        payload["titleId"] = json!(p.title_id);
        payload["tier"] = json!(p.tier);
        payload["division"] = json!(p.division);
        payload["rp"] = json!(p.rp);
    }
    let resp = request(&base, "POST", "/v1/join", None, Body::Json(payload))?;
    let v: Value = serde_json::from_slice(&resp.body).map_err(|_| LbError::local("invalid", "The leaderboard sent an unreadable answer."))?;
    let token = v["token"].as_str().unwrap_or("").to_string();
    let player_id = v["player"]["id"].as_str().unwrap_or("").to_string();
    if token.is_empty() || player_id.is_empty() {
        return Err(LbError::local("invalid", "The leaderboard sent an incomplete answer."));
    }
    let shown = v["player"]["name"].as_str().unwrap_or(&name).to_string();
    set_account(Some(Account {
        base_url: base,
        player_id,
        token,
        display_name: shown,
        last_profile: profile,
        avatar_pending: my_avatar_path().is_some(),
        ..Account::default()
    }));
    log::info!("leaderboard: joined");
    kick(true);
    Ok(status_now())
}

/// Returns true when the server confirmed the deletion (or the account was already gone).
pub fn leave() -> bool {
    if read_account(|_| ()).is_none() {
        return true;
    }
    with_account(|a| {
        a.pending_leave = true;
        a.outbox = Outbox::default();
        a.inflight = None;
    });
    emit_changed();
    finish_pending_leave().is_ok()
}

fn finish_pending_leave() -> Result<(), LbError> {
    let Some((base, token)) = read_account(|a| (a.base_url.clone(), a.token.clone())) else { return Ok(()) };
    match request(&base, "DELETE", "/v1/me", Some(&token), Body::None) {
        Ok(_) => {}
        Err(e) if e.status == 401 || e.status == 404 => {}
        Err(e) => return Err(e),
    }
    set_account(None);
    log::info!("leaderboard: left, server data deleted");
    Ok(())
}

// ---------------------------------------------------------------- board

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub rank: Option<i64>,
    pub player_id: String,
    pub name: String,
    /// Title id as the server stores it ("night-owl"); `src/lib/leaderboard.ts` maps it to the display name.
    pub title: Option<String>,
    pub tier: i64,
    pub division: i64,
    pub rp: i64,
    pub score: i64,
    pub has_avatar: bool,
    /// Changes whenever the picture changes; part of the cache key.
    pub avatar_version: Option<String>,
    pub me: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub cat: String,
    /// ISO week key like "2026-W47".
    pub week: String,
    pub starts_at: String,
    pub ends_at: String,
    pub current: bool,
    pub total: i64,
    pub rows: Vec<Row>,
    pub me: Option<Row>,
}

/// Avatar paths (with `?v=`) of the rows seen last, so `avatar()` fetches the current picture.
static AVATAR_PATHS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn parse_row(v: &Value) -> Option<(Row, Option<String>)> {
    let id = v["id"].as_str()?.to_string();
    let avatar = v["avatar"].as_str().map(str::to_string);
    let version = avatar.as_deref().and_then(|p| p.split("?v=").nth(1)).map(str::to_string);
    Some((
        Row {
            rank: v["rank"].as_i64(),
            player_id: id,
            name: v["name"].as_str().unwrap_or("").to_string(),
            title: v["titleId"].as_str().map(str::to_string),
            tier: v["tier"].as_i64().unwrap_or(0),
            division: v["division"].as_i64().unwrap_or(0),
            rp: v["rp"].as_i64().unwrap_or(0),
            score: v["value"].as_i64().unwrap_or(0),
            has_avatar: avatar.is_some(),
            avatar_version: version,
            me: v["me"].as_bool().unwrap_or(false),
        },
        avatar,
    ))
}

pub fn board(cat: &str) -> Result<Board, LbError> {
    if !CATEGORIES.contains(&cat) {
        return Err(LbError::local("invalid", "Unknown leaderboard category."));
    }
    let resp = authed("GET", &format!("/v1/leaderboard?cat={cat}"), Body::None)?;
    let v: Value = serde_json::from_slice(&resp.body).map_err(|_| LbError::local("invalid", "The leaderboard sent an unreadable answer."))?;
    let mut paths = HashMap::new();
    let mut rows = vec![];
    for r in v["rows"].as_array().cloned().unwrap_or_default() {
        if let Some((row, avatar)) = parse_row(&r) {
            if let Some(p) = avatar {
                paths.insert(row.player_id.clone(), p);
            }
            rows.push(row);
        }
    }
    let me = parse_row(&v["me"]).map(|(row, avatar)| {
        if let Some(p) = avatar {
            paths.insert(row.player_id.clone(), p);
        }
        row
    });
    if let Some(m) = v["me"].as_object() {
        let hidden = m.get("hidden").and_then(Value::as_bool).unwrap_or(false);
        with_account(|a| a.hidden = hidden);
    }
    *AVATAR_PATHS.lock().unwrap_or_else(|e| e.into_inner()) = Some(paths);
    Ok(Board {
        cat: cat.to_string(),
        week: v["week"]["key"].as_str().unwrap_or("").to_string(),
        starts_at: v["week"]["startsAt"].as_str().unwrap_or("").to_string(),
        ends_at: v["week"]["endsAt"].as_str().unwrap_or("").to_string(),
        current: v["week"]["current"].as_bool().unwrap_or(true),
        total: v["total"].as_i64().unwrap_or(0),
        rows,
        me,
    })
}

fn valid_player_id(id: &str) -> bool {
    id.len() == 18 && id.starts_with("p_") && id[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Picture bytes of another player (needs the token, so the page cannot load it by URL).
pub fn avatar(player_id: &str) -> Result<Vec<u8>, LbError> {
    if !valid_player_id(player_id) {
        return Err(LbError::local("invalid", "Unknown player."));
    }
    let known = AVATAR_PATHS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|m| m.get(player_id).cloned());
    let path = known.unwrap_or_else(|| format!("/v1/avatar/{player_id}"));
    Ok(authed("GET", &path, Body::None)?.body)
}

// ---------------------------------------------------------------- profile edits and reports

pub fn update_me(fields: &Value) -> Result<(), LbError> {
    let obj = fields.as_object().ok_or_else(|| LbError::local("invalid", "Nothing to update."))?;
    let mut payload = serde_json::Map::new();
    for key in ["name", "titleId", "tier", "division", "rp"] {
        if let Some(v) = obj.get(key) {
            payload.insert(key.to_string(), if key == "name" { json!(clean_name(v.as_str().unwrap_or(""))) } else { v.clone() });
        }
    }
    if payload.is_empty() {
        return Err(LbError::local("invalid", "Nothing to update."));
    }
    let resp = authed("PUT", "/v1/me", Body::Json(Value::Object(payload.clone())))?;
    let v: Value = serde_json::from_slice(&resp.body).unwrap_or(Value::Null);
    with_account(|a| {
        if let Some(n) = v["player"]["name"].as_str().or_else(|| v["name"].as_str()) {
            a.display_name = n.to_string();
        } else if let Some(n) = payload.get("name").and_then(Value::as_str) {
            a.display_name = n.to_string();
        }
        // Remember what the server has now, so the next sync does not undo or repeat it.
        if let Some(p) = a.last_profile.as_mut() {
            if let Some(t) = payload.get("titleId") {
                p.title_id = t.as_str().map(str::to_string);
            }
            if let Some(x) = payload.get("tier").and_then(Value::as_i64) {
                p.tier = x;
            }
            if let Some(x) = payload.get("division").and_then(Value::as_i64) {
                p.division = x;
            }
            if let Some(x) = payload.get("rp").and_then(Value::as_i64) {
                p.rp = x;
            }
        }
    });
    emit_changed();
    Ok(())
}

pub fn report(player_id: &str, kind: &str, note: Option<&str>) -> Result<(), LbError> {
    if !valid_player_id(player_id) || !matches!(kind, "name" | "avatar" | "player") {
        return Err(LbError::local("invalid", "Unknown player or report type."));
    }
    let mut payload = json!({ "playerId": player_id, "kind": kind });
    if let Some(n) = note.map(str::trim).filter(|n| !n.is_empty()) {
        payload["note"] = json!(n.chars().take(200).collect::<String>());
    }
    authed("POST", "/v1/report", Body::Json(payload))?;
    Ok(())
}

// ---------------------------------------------------------------- own picture

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ImageKind {
    Png,
    Jpeg,
    Webp,
}

impl ImageKind {
    pub fn mime(self) -> &'static str {
        match self {
            ImageKind::Png => "image/png",
            ImageKind::Jpeg => "image/jpeg",
            ImageKind::Webp => "image/webp",
        }
    }
    fn ext(self) -> &'static str {
        match self {
            ImageKind::Png => "png",
            ImageKind::Jpeg => "jpg",
            ImageKind::Webp => "webp",
        }
    }
}

pub fn sniff_image(b: &[u8]) -> Option<ImageKind> {
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(ImageKind::Png)
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageKind::Jpeg)
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some(ImageKind::Webp)
    } else {
        None
    }
}

fn be16(b: &[u8], i: usize) -> Option<u32> {
    Some(((*b.get(i)? as u32) << 8) | *b.get(i + 1)? as u32)
}
fn le16(b: &[u8], i: usize) -> Option<u32> {
    Some((*b.get(i)? as u32) | ((*b.get(i + 1)? as u32) << 8))
}
fn le24(b: &[u8], i: usize) -> Option<u32> {
    Some(le16(b, i)? | ((*b.get(i + 2)? as u32) << 16))
}

/// Width and height from the file header, without decoding.
pub fn image_size(b: &[u8], kind: ImageKind) -> Option<(u32, u32)> {
    match kind {
        ImageKind::Png => {
            let w = (be16(b, 16)? << 16) | be16(b, 18)?;
            let h = (be16(b, 20)? << 16) | be16(b, 22)?;
            Some((w, h))
        }
        ImageKind::Jpeg => {
            let mut i = 2;
            while i + 9 < b.len() {
                if b[i] != 0xFF {
                    i += 1;
                    continue;
                }
                let marker = b[i + 1];
                if marker == 0xFF {
                    i += 1;
                    continue;
                }
                if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
                    i += 2;
                    continue;
                }
                let len = be16(b, i + 2)? as usize;
                if matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
                    return Some((be16(b, i + 7)?, be16(b, i + 5)?));
                }
                i += 2 + len;
            }
            None
        }
        ImageKind::Webp => match b.get(12..16)? {
            b"VP8 " => Some((le16(b, 26)? & 0x3fff, le16(b, 28)? & 0x3fff)),
            b"VP8L" => {
                let (b1, b2, b3, b4) = (*b.get(21)? as u32, *b.get(22)? as u32, *b.get(23)? as u32, *b.get(24)? as u32);
                Some((1 + (b1 | ((b2 & 0x3f) << 8)), 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10))))
            }
            b"VP8X" => Some((1 + le24(b, 24)?, 1 + le24(b, 27)?)),
            _ => None,
        },
    }
}

/// Same rules as the server: PNG/JPEG/WEBP, at most 256 KB, square, 32 to 1024 px.
pub fn validate_avatar(bytes: &[u8], mime: &str) -> Result<ImageKind, LbError> {
    if bytes.len() > AVATAR_MAX_BYTES {
        return Err(LbError::local("invalid", "The picture is larger than 256 KB."));
    }
    let kind = sniff_image(bytes).ok_or_else(|| LbError::local("invalid", "Use a PNG, JPEG or WEBP picture."))?;
    if !mime.is_empty() && !mime.eq_ignore_ascii_case(kind.mime()) {
        return Err(LbError::local("invalid", "The picture type does not match its content."));
    }
    let (w, h) = image_size(bytes, kind).ok_or_else(|| LbError::local("invalid", "The picture could not be read."))?;
    if w != h || !(AVATAR_MIN_SIDE..=AVATAR_MAX_SIDE).contains(&w) {
        return Err(LbError::local("invalid", "The picture must be square, between 32 and 1024 pixels."));
    }
    Ok(kind)
}

fn avatar_file(kind: ImageKind) -> PathBuf {
    crate::settings::data_dir().join(format!("profile-picture.{}", kind.ext()))
}

fn my_avatar_path() -> Option<PathBuf> {
    [ImageKind::Png, ImageKind::Jpeg, ImageKind::Webp].into_iter().map(avatar_file).find(|p| p.exists())
}

/// The local profile picture (bytes), if one was saved.
pub fn my_avatar() -> Option<Vec<u8>> {
    std::fs::read(my_avatar_path()?).ok()
}

fn picture_unlocked() -> bool {
    crate::economy::economy_state()
        .map(|s| s.inventory.iter().any(|i| i.item_id == crate::economy::PROFILE_PICTURE_ID))
        .unwrap_or(false)
}

/// Store the picture locally and, if the player joined, upload it.
pub fn save_my_avatar(bytes: &[u8], mime: &str) -> Result<(), LbError> {
    if !picture_unlocked() {
        return Err(LbError::local("locked", "Unlock the profile picture in the shop first."));
    }
    let kind = validate_avatar(bytes, mime)?;
    for k in [ImageKind::Png, ImageKind::Jpeg, ImageKind::Webp] {
        let _ = std::fs::remove_file(avatar_file(k));
    }
    std::fs::write(avatar_file(kind), bytes).map_err(|e| LbError::local("invalid", &format!("The picture could not be saved: {e}")))?;
    with_account(|a| a.avatar_delete_pending = false);
    if is_joined() {
        match upload_avatar(bytes, kind) {
            Ok(()) => {
                with_account(|a| a.avatar_pending = false);
            }
            Err(e) if e.retryable() => {
                with_account(|a| a.avatar_pending = true);
                kick(false);
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Delete the local picture and, if the player joined, the server copy (`DELETE /v1/me/avatar`).
/// The unlock (shop item) stays owned. A network error keeps the server deletion pending.
pub fn remove_my_avatar() -> Result<(), LbError> {
    for k in [ImageKind::Png, ImageKind::Jpeg, ImageKind::Webp] {
        let p = avatar_file(k);
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| LbError::local("invalid", &format!("The picture could not be removed: {e}")))?;
        }
    }
    with_account(|a| a.avatar_pending = false);
    if !is_joined() {
        return Ok(());
    }
    match delete_avatar() {
        Ok(()) => Ok(()),
        Err(e) if e.retryable() => {
            with_account(|a| a.avatar_delete_pending = true);
            kick(false);
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn delete_avatar() -> Result<(), LbError> {
    match authed("DELETE", "/v1/me/avatar", Body::None) {
        Ok(_) => {}
        Err(e) if e.status == 404 => {}
        Err(e) => return Err(e),
    }
    with_account(|a| a.avatar_delete_pending = false);
    emit_changed();
    Ok(())
}

fn upload_avatar(bytes: &[u8], kind: ImageKind) -> Result<(), LbError> {
    authed("PUT", "/v1/me/avatar", Body::Bytes(bytes, kind.mime()))?;
    emit_changed();
    Ok(())
}

// ---------------------------------------------------------------- sync

static SYNC_LOCK: Mutex<()> = Mutex::new(());

/// Send everything that is pending. Safe to call from any thread, one run at a time.
/// Returns whether anything is still pending afterwards.
pub fn sync_now() -> Result<bool, LbError> {
    let _one_at_a_time = SYNC_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if read_account(|a| a.pending_leave).unwrap_or(false) {
        finish_pending_leave()?;
        return Ok(false);
    }
    if !is_joined() {
        return Ok(false);
    }
    let mut sent_scores = false;
    for _ in 0..8 {
        let batch = with_account(|a| {
            if a.inflight.is_none() {
                a.inflight = a.outbox.take_batch();
            }
            a.inflight.clone()
        })
        .flatten();
        let Some(batch) = batch else { break };
        let payload = json!({
            "batchId": batch.batch_id,
            "points": batch.points,
            "words": batch.words,
            "games": batch.games.iter().map(|(g, s)| json!({ "game": g, "score": s })).collect::<Vec<_>>(),
        });
        match authed("POST", "/v1/scores", Body::Json(payload)) {
            Ok(resp) => {
                let v: Value = serde_json::from_slice(&resp.body).unwrap_or(Value::Null);
                with_account(|a| {
                    a.inflight = None;
                    let m = &v["player"]["moderation"];
                    a.hidden = m["hidden"].as_bool().unwrap_or(a.hidden);
                    a.avatar_hidden = m["avatarHidden"].as_bool().unwrap_or(a.avatar_hidden);
                });
                sent_scores = true;
            }
            Err(e) if e.retryable() || e.status == 401 => return Err(e),
            Err(e) => {
                // The server will never accept this batch: drop it instead of retrying forever.
                log::warn!("leaderboard: batch rejected ({}), dropped", e.code);
                with_account(|a| a.inflight = None);
            }
        }
    }
    // Rank and title.
    if let Some(now) = current_profile() {
        let changed = read_account(|a| a.last_profile.as_ref() != Some(&now)).unwrap_or(false);
        if changed {
            let mut payload = json!({ "tier": now.tier, "division": now.division, "rp": now.rp });
            payload["titleId"] = json!(now.title_id);
            match authed("PUT", "/v1/me", Body::Json(payload)) {
                Ok(_) => {
                    with_account(|a| a.last_profile = Some(now));
                    sent_scores = true;
                }
                Err(e) if e.retryable() || e.status == 401 => return Err(e),
                Err(e) => {
                    log::warn!("leaderboard: profile update rejected ({}), skipped", e.code);
                    with_account(|a| a.last_profile = Some(now));
                }
            }
        }
    }
    // A picture removal the server has not seen yet.
    if read_account(|a| a.avatar_delete_pending).unwrap_or(false) {
        match delete_avatar() {
            Ok(()) => {}
            Err(e) if e.retryable() || e.status == 401 => return Err(e),
            Err(e) => {
                log::warn!("leaderboard: picture removal rejected ({}), not retried", e.code);
                with_account(|a| a.avatar_delete_pending = false);
            }
        }
    }
    // A picture that could not be uploaded earlier.
    if read_account(|a| a.avatar_pending).unwrap_or(false) {
        match my_avatar().and_then(|b| sniff_image(&b).map(|k| (b, k))) {
            Some((b, k)) => match upload_avatar(&b, k) {
                Ok(()) => {
                    with_account(|a| a.avatar_pending = false);
                }
                Err(e) if e.retryable() || e.status == 401 => return Err(e),
                Err(e) => {
                    log::warn!("leaderboard: picture rejected ({}), not retried", e.code);
                    with_account(|a| a.avatar_pending = false);
                }
            },
            None => {
                with_account(|a| a.avatar_pending = false);
            }
        }
    }
    if sent_scores {
        emit_changed();
    }
    Ok(read_account(|a| a.inflight.is_some() || !a.outbox.is_empty()).unwrap_or(false))
}

// ---------------------------------------------------------------- Monday payout

/// ISO week key of `now` in UTC, "2026-W47" (same as the server's `isoWeek`).
fn iso_week_key(now: chrono::DateTime<chrono::Utc>) -> String {
    use chrono::Datelike;
    let w = now.iso_week();
    format!("{}-W{:02}", w.year(), w.week())
}

/// Read `lastWeek` from `GET /v1/me` and pay the Monday payout for a top three finish (once per
/// week, guarded in the economy database). Not joined: no request, `None`. Joined: at most one
/// request per ISO week, the week already checked is remembered in the account file.
pub fn claim_weekly_payout() -> Result<Option<crate::economy::WeeklyPayout>, LbError> {
    if !is_joined() {
        return Ok(None);
    }
    let current = iso_week_key(chrono::Utc::now());
    if read_account(|a| a.payout_checked == current).unwrap_or(false) {
        return Ok(None);
    }
    let resp = authed("GET", "/v1/me", Body::None)?;
    let v: Value = serde_json::from_slice(&resp.body).map_err(|_| LbError::local("invalid", "The leaderboard sent an unreadable answer."))?;
    let last = &v["lastWeek"];
    let paid = match last["key"].as_str() {
        Some(key) => crate::economy::claim_weekly_payout(key, last["rank"].as_i64())?,
        None => None,
    };
    let checked = v["week"]["key"].as_str().map(str::to_string).unwrap_or(current);
    with_account(|a| {
        a.payout_checked = checked;
        let m = &v["player"]["moderation"];
        a.hidden = m["hidden"].as_bool().unwrap_or(a.hidden);
        a.avatar_hidden = m["avatarHidden"].as_bool().unwrap_or(a.avatar_hidden);
    });
    if let Some(p) = &paid {
        log::info!("leaderboard: Monday payout {} coins for {} rank {}", p.coins, p.week, p.rank);
    }
    Ok(paid)
}

// ---------------------------------------------------------------- hooks from the economy

/// A round ended (also when left early). Called by `economy_award_game`; never blocks, silent.
pub fn on_game(game: &str, score: i64, rp: i64) {
    if !is_joined() {
        return;
    }
    let cap = match game {
        "tower" => 10_000,
        "snake" => 5_000,
        "comet" => 1_000_000,
        _ => return,
    };
    with_account(|a| {
        a.outbox.points += rp.max(0);
        if score > 0 {
            let e = a.outbox.games.entry(game.to_string()).or_insert(0);
            *e = (*e).max(score.min(cap));
        }
    });
    kick(true);
}

/// A dictation was saved. Called by `economy::on_dictation_saved`; at most one request a minute.
pub fn on_dictation(words: i64, rp: i64) {
    if !is_joined() {
        return;
    }
    with_account(|a| {
        a.outbox.points += rp.max(0);
        a.outbox.words += words.max(0);
    });
    kick(false);
}

/// The equipped title or rank changed (shop, box, promotion).
pub fn on_profile_changed() {
    if is_joined() {
        kick(false);
    }
}

// ---------------------------------------------------------------- worker

static WORKER: OnceLock<Mutex<Sender<bool>>> = OnceLock::new();

/// Ask the worker for a sync. `urgent` = after a game (a few seconds), else within a minute.
fn kick(urgent: bool) {
    let tx = WORKER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<bool>();
        let spawned = std::thread::Builder::new().name("leaderboard-sync".into()).spawn(move || worker(rx));
        if spawned.is_err() {
            log::warn!("leaderboard: sync worker could not start");
        }
        Mutex::new(tx)
    });
    let _ = tx.lock().unwrap_or_else(|e| e.into_inner()).send(urgent);
}

fn worker(rx: mpsc::Receiver<bool>) {
    const URGENT_GAP: Duration = Duration::from_secs(3);
    const LAZY_GAP: Duration = Duration::from_secs(60);
    const IDLE: Duration = Duration::from_secs(300);
    let mut last_run = Instant::now() - LAZY_GAP;
    let mut want_at: Option<Instant> = None;
    let mut backoff = Duration::from_secs(30);
    loop {
        let wait = match want_at {
            Some(t) => t.saturating_duration_since(Instant::now()),
            None => IDLE,
        };
        match rx.recv_timeout(wait) {
            Ok(urgent) => {
                let gap = if urgent { URGENT_GAP } else { LAZY_GAP };
                let candidate = (last_run + gap).max(Instant::now());
                want_at = Some(want_at.map_or(candidate, |w| w.min(candidate)));
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        // Either the wanted moment came or the idle timer fired (retry whatever is pending).
        let pending = read_account(|a| a.pending_leave || a.inflight.is_some() || !a.outbox.is_empty() || a.avatar_pending || a.avatar_delete_pending).unwrap_or(false);
        if want_at.is_none() && !pending {
            if read_account(|_| ()).is_none() {
                // Left or removed: nothing to do, the next join starts the worker's work again.
            }
            continue;
        }
        last_run = Instant::now();
        match sync_now() {
            Ok(_) => {
                backoff = Duration::from_secs(30);
                want_at = None;
            }
            Err(e) => {
                log::info!("leaderboard: sync will retry ({})", e.code);
                let wait = e.retry_after.map(Duration::from_secs).unwrap_or(backoff);
                want_at = Some(Instant::now() + wait.max(Duration::from_secs(10)));
                backoff = (backoff * 2).min(Duration::from_secs(900));
            }
        }
    }
}

/// App start: only touches the network when an unfinished leave or unsent scores exist,
/// which implies the player joined earlier. A player who never joined causes no request.
pub fn init() {
    let pending = read_account(|a| a.pending_leave || a.inflight.is_some() || !a.outbox.is_empty() || a.avatar_pending || a.avatar_delete_pending).unwrap_or(false);
    if pending {
        kick(false);
    }
}

// ---------------------------------------------------------------- commands

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, LbError> + Send + 'static) -> Result<T, LbError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| LbError::local("invalid", "The leaderboard task failed."))?
}

#[tauri::command]
pub fn leaderboard_status() -> Status {
    status_now()
}

#[tauri::command]
pub async fn leaderboard_join(display_name: String) -> Result<Status, LbError> {
    blocking(move || join(&display_name)).await
}

/// `serverDeleted` is false when the server could not be reached; the deletion is retried later.
#[tauri::command]
pub async fn leaderboard_leave() -> Result<Value, LbError> {
    blocking(|| Ok(json!({ "serverDeleted": leave() }))).await
}

#[tauri::command]
pub async fn leaderboard_board(cat: String) -> Result<Board, LbError> {
    blocking(move || board(&cat)).await
}

#[tauri::command]
pub async fn leaderboard_avatar(player_id: String) -> Result<tauri::ipc::Response, LbError> {
    blocking(move || avatar(&player_id)).await.map(tauri::ipc::Response::new)
}

#[tauri::command]
pub async fn leaderboard_update_me(fields: Value) -> Result<(), LbError> {
    blocking(move || update_me(&fields)).await
}

/// `reason` is the report kind: "name" | "avatar" | "player".
#[tauri::command]
pub async fn leaderboard_report(player_id: String, reason: String, note: Option<String>) -> Result<(), LbError> {
    blocking(move || report(&player_id, &reason, note.as_deref())).await
}

#[tauri::command]
pub async fn leaderboard_sync() -> Result<bool, LbError> {
    blocking(sync_now).await
}

/// Raw bytes as the body, mime in the `x-mime` header (see `saveMyAvatar` in src/lib/leaderboard.ts).
#[tauri::command]
pub async fn leaderboard_avatar_save(request: tauri::ipc::Request<'_>) -> Result<(), LbError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(LbError::local("invalid", "Expected raw picture bytes."));
    };
    let bytes = bytes.clone();
    let mime = request.headers().get("x-mime").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    blocking(move || save_my_avatar(&bytes, &mime)).await
}

/// Deletes the local picture and the server copy (when joined). The unlock stays owned.
#[tauri::command]
pub async fn leaderboard_avatar_remove() -> Result<(), LbError> {
    blocking(remove_my_avatar).await
}

/// Monday payout: `None` when not joined, already paid or no top three finish last week.
#[tauri::command]
pub async fn leaderboard_claim_payout() -> Result<Option<crate::economy::WeeklyPayout>, LbError> {
    blocking(claim_weekly_payout).await
}

/// The local picture, or an empty body when none was saved.
#[tauri::command]
pub async fn leaderboard_my_avatar() -> Result<tauri::ipc::Response, LbError> {
    blocking(|| Ok(my_avatar().unwrap_or_default())).await.map(tauri::ipc::Response::new)
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_rules() {
        assert_eq!(valid_base("https://leaderboard.example.com/"), Some("https://leaderboard.example.com".into()));
        assert_eq!(valid_base(" http://127.0.0.1:8787 "), Some("http://127.0.0.1:8787".into()));
        assert_eq!(valid_base("http://localhost:8787"), Some("http://localhost:8787".into()));
        assert_eq!(valid_base("http://example.com"), None, "no token in clear text over the internet");
        assert_eq!(valid_base("ftp://example.com"), None);
        assert_eq!(valid_base(""), None);
        assert_eq!(valid_base("https://"), None);
    }

    #[test]
    fn title_slugs_match_the_server_pattern() {
        assert_eq!(title_slug("Night Owl").as_deref(), Some("night-owl"));
        assert_eq!(title_slug("Ctrl Z").as_deref(), Some("ctrl-z"));
        assert_eq!(title_slug("  Hold to Talk! ").as_deref(), Some("hold-to-talk"));
        assert_eq!(title_slug("!!!"), None);
        let long = title_slug(&"abc ".repeat(20)).unwrap();
        assert!(long.len() <= 32 && !long.ends_with('-'));
    }

    #[test]
    fn outbox_batches_respect_limits_and_ids_differ() {
        let mut o = Outbox { points: 12_000, words: 45_000, games: BTreeMap::new() };
        o.games.insert("tower".into(), 40);
        let a = o.take_batch().unwrap();
        assert_eq!((a.points, a.words, a.games.len()), (5_000, 20_000, 1));
        let b = o.take_batch().unwrap();
        assert_eq!((b.points, b.words, b.games.len()), (5_000, 20_000, 0));
        let c = o.take_batch().unwrap();
        assert_eq!((c.points, c.words), (2_000, 5_000));
        assert!(o.take_batch().is_none());
        assert_ne!(a.batch_id, b.batch_id);
    }

    #[test]
    fn server_errors_are_parsed() {
        let body = br#"{"error":{"code":"validation_failed","message":"Name not allowed","details":{"field":"name","reason":"profanity"}}}"#;
        let e = error_from(400, body, None);
        assert_eq!((e.code.as_str(), e.reason.as_deref(), e.status), ("validation_failed", Some("profanity"), 400));
        assert!(!e.retryable());
        let e = error_from(429, br#"{"error":{"code":"rate_limited","message":"slow down"}}"#, Some(30));
        assert!(e.retryable() && e.retry_after == Some(30));
        let e = error_from(502, b"<html>", None);
        assert!(e.retryable() && e.code == "http_502");
    }

    fn png(w: u32, h: u32, extra: usize) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        v.extend(w.to_be_bytes());
        v.extend(h.to_be_bytes());
        v.extend(std::iter::repeat(0).take(extra));
        v
    }

    #[test]
    fn avatar_validation_matches_the_server() {
        assert_eq!(validate_avatar(&png(256, 256, 100), "image/png").unwrap(), ImageKind::Png);
        assert!(validate_avatar(&png(256, 128, 100), "image/png").is_err(), "not square");
        assert!(validate_avatar(&png(16, 16, 100), "image/png").is_err(), "too small");
        assert!(validate_avatar(&png(2048, 2048, 100), "image/png").is_err(), "too big a side");
        assert!(validate_avatar(&png(256, 256, 300 * 1024), "image/png").is_err(), "over 256 KB");
        assert!(validate_avatar(&png(256, 256, 10), "image/jpeg").is_err(), "mime mismatch");
        assert!(validate_avatar(b"GIF89a....", "image/gif").is_err());
    }

    #[test]
    fn jpeg_and_webp_headers_are_read() {
        // SOI, APP0 (len 4), SOF0 with 200 x 200.
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0, 0, 0xFF, 0xC0, 0x00, 0x11, 8, 0x00, 0xC8, 0x00, 0xC8, 3, 0, 0, 0];
        assert_eq!(image_size(&jpeg, ImageKind::Jpeg), Some((200, 200)));
        // RIFF .... WEBP VP8X, canvas 99 x 99 (stored minus one).
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0".to_vec();
        webp.extend([98, 0, 0, 98, 0, 0]);
        assert_eq!(sniff_image(&webp), Some(ImageKind::Webp));
        assert_eq!(image_size(&webp, ImageKind::Webp), Some((99, 99)));
    }

    #[test]
    fn iso_week_keys_match_the_server() {
        use chrono::TimeZone;
        let at = |y, m, d, h| chrono::Utc.with_ymd_and_hms(y, m, d, h, 0, 0).unwrap();
        assert_eq!(iso_week_key(at(2026, 11, 18, 12)), "2026-W47");
        assert_eq!(iso_week_key(at(2026, 11, 16, 0)), "2026-W47", "Monday 00:00 UTC starts the week");
        assert_eq!(iso_week_key(at(2026, 11, 15, 23)), "2026-W46");
        assert_eq!(iso_week_key(at(2027, 1, 1, 12)), "2026-W53");
        assert_eq!(iso_week_key(at(2026, 1, 5, 0)), "2026-W02");
    }

    #[test]
    fn player_ids_are_checked_before_they_reach_a_url() {
        assert!(valid_player_id("p_0123456789abcdef"));
        assert!(!valid_player_id("p_../../v1/admin/x"));
        assert!(!valid_player_id("p_0123456789ABCDEF"));
    }

    #[test]
    fn profile_follows_the_economy() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        crate::economy::init_schema(&c).unwrap();
        let mut s = crate::economy::state_with(&c, "2026-11-18").unwrap();
        let p = profile_from(&s);
        assert_eq!((p.tier, p.division, p.rp, p.title_id.clone()), (0, 0, 0, None));
        s.equipped.insert("title".into(), "Night Owl".into());
        s.rank.tier = 6;
        s.rank.division = None;
        s.rank.rp = 4_000;
        let p = profile_from(&s);
        assert_eq!((p.tier, p.division, p.rp, p.title_id.as_deref()), (6, 0, 100, Some("night-owl")));
    }

    #[test]
    fn not_joined_means_no_network() {
        // The commands that need an account refuse locally, before any request is built.
        // (Runs against whatever data folder the test process uses; a stored account would make
        // this test meaningless, so it only asserts when none exists.)
        if read_account(|_| ()).is_none() {
            let before = request_count();
            assert_eq!(board("overall").unwrap_err().code, "not_joined");
            assert_eq!(avatar("p_0123456789abcdef").unwrap_err().code, "not_joined");
            assert_eq!(report("p_0123456789abcdef", "name", None).unwrap_err().code, "not_joined");
            assert_eq!(update_me(&json!({ "name": "abc" })).unwrap_err().code, "not_joined");
            assert!(claim_weekly_payout().unwrap().is_none());
            assert!(!sync_now().unwrap());
            assert_eq!(request_count(), before);
        }
    }

    /// End to end against the local Worker (`npm run dev` in server/leaderboard, 127.0.0.1:8787):
    /// `cargo test --lib leaderboard_e2e -- --ignored --nocapture --test-threads=1`
    /// Uses a throwaway data folder; the player and the second account are deleted at the end.
    #[test]
    #[ignore]
    fn leaderboard_e2e() {
        let tmp = std::env::temp_dir().join(format!("spechy-lb-e2e-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("APPDATA", &tmp);
        std::env::set_var("XDG_DATA_HOME", &tmp);
        crate::db::init().unwrap();

        // 1. Not joined: configured (debug default), zero requests, commands refuse locally.
        let st = status_now();
        assert!(!st.joined && st.server_configured);
        assert_eq!(board("overall").unwrap_err().code, "not_joined");
        assert_eq!(request_count(), 0, "no request before joining");

        // 2. Join.
        let st = join("E2E Tester").unwrap();
        assert!(st.joined && st.display_name.as_deref() == Some("E2E Tester"));
        let (token, my_id) = read_account(|a| (a.token.clone(), a.player_id.clone())).unwrap();
        assert!(token.starts_with("spk_") && account_path().exists());
        assert_eq!(join("Someone Else").unwrap_err().code, "already_joined");
        // The server rejects a bad name with the reason the form shows.
        let bad = request(&configured_base().unwrap(), "POST", "/v1/join", None, Body::Json(json!({ "name": "x" }))).unwrap_err();
        assert_eq!(bad.reason.as_deref(), Some("length"));

        // 3. Game and dictation awards go to the outbox and are synced in batches.
        on_game("tower", 42, 10);
        on_game("snake", 7, 4);
        on_dictation(300, 5);
        sync_now().unwrap();
        assert!(!read_account(|a| a.inflight.is_some() || !a.outbox.is_empty()).unwrap());
        let b = board("overall").unwrap();
        assert_eq!(b.me.as_ref().unwrap().score, 19, "points = RP earned");
        assert_eq!(board("words").unwrap().me.unwrap().score, 300);
        assert_eq!(board("tower").unwrap().me.unwrap().score, 42);
        assert_eq!(board("snake").unwrap().me.unwrap().score, 7);
        assert!(b.rows.iter().any(|r| r.me && r.name == "E2E Tester"));

        // 4. Retrying a batch with the same id never counts twice.
        let batch = Batch { batch_id: "e2e-fixed-batch-1".into(), points: 3, words: 0, games: vec![] };
        let payload = json!({ "batchId": batch.batch_id, "points": 3, "words": 0, "games": [] });
        authed("POST", "/v1/scores", Body::Json(payload.clone())).unwrap();
        authed("POST", "/v1/scores", Body::Json(payload)).unwrap();
        assert_eq!(board("overall").unwrap().me.unwrap().score, 22);

        // 5. Picture: locked until the shop item is owned, then local save plus upload and fetch.
        let pic = png(64, 64, 200);
        assert_eq!(save_my_avatar(&pic, "image/png").unwrap_err().code, "locked");
        crate::economy::economy_dev_set_unlimited(true).unwrap();
        crate::economy::economy_buy(crate::economy::PROFILE_PICTURE_ID.to_string()).unwrap();
        save_my_avatar(&pic, "image/png").unwrap();
        assert_eq!(my_avatar().unwrap(), pic);
        let b = board("overall").unwrap();
        assert!(b.me.as_ref().unwrap().has_avatar, "server has the picture");
        assert_eq!(avatar(&my_id).unwrap(), pic);

        // 5b. Monday payout: one GET /v1/me a week; a new player has no last week, so nothing is paid.
        let before = request_count();
        assert!(claim_weekly_payout().unwrap().is_none());
        assert!(claim_weekly_payout().unwrap().is_none());
        assert_eq!(request_count(), before + 1, "lastWeek is read once per week");

        // 5c. Remove the picture: local file and server copy go, the unlock stays.
        remove_my_avatar().unwrap();
        assert!(my_avatar().is_none());
        assert!(!board("overall").unwrap().me.unwrap().has_avatar, "server copy deleted");
        assert!(picture_unlocked());
        save_my_avatar(&pic, "image/png").unwrap();
        assert!(board("overall").unwrap().me.unwrap().has_avatar);

        // 6. Profile fields and a report against a second player.
        update_me(&json!({ "name": "E2E Renamed" })).unwrap();
        assert_eq!(status_now().display_name.as_deref(), Some("E2E Renamed"));
        let second = request(&configured_base().unwrap(), "POST", "/v1/join", None, Body::Json(json!({ "name": "E2E Other" }))).unwrap();
        let sv: Value = serde_json::from_slice(&second.body).unwrap();
        let (other_token, other_id) = (sv["token"].as_str().unwrap().to_string(), sv["player"]["id"].as_str().unwrap().to_string());
        report(&other_id, "name", Some("e2e test")).unwrap();
        assert!(report(&my_id, "name", None).is_err(), "own row cannot be reported");

        // 7. The data export never contains the token.
        let export = crate::db::export_json().unwrap();
        assert!(!export.contains(&token) && !export.contains("spk_"), "token leaked into the export");
        let ev: Value = serde_json::from_str(&export).unwrap();
        assert!(ev["economy"]["ledger"].as_array().is_some_and(|l| !l.is_empty()), "economy in the export");
        assert!(!std::fs::read_to_string(tmp.join("com.remo.spechy").join("settings.json")).unwrap().contains(&token));

        // 8. Leave: server data is gone, the account file too, and the old token is dead.
        assert!(leave());
        assert!(!status_now().joined && !account_path().exists());
        let gone = request(&configured_base().unwrap(), "GET", "/v1/me", Some(&token), Body::None).unwrap_err();
        assert_eq!(gone.status, 401);
        let seen = request(&configured_base().unwrap(), "GET", "/v1/leaderboard?cat=overall", Some(&other_token), Body::None).unwrap();
        assert!(!String::from_utf8_lossy(&seen.body).contains(&my_id), "player still listed after leaving");
        // the local picture stays (it is the user's own file); the server copy is deleted with the account
        assert!(my_avatar().is_some());
        let av = request(&configured_base().unwrap(), "GET", &format!("/v1/avatar/{my_id}"), Some(&other_token), Body::None).unwrap_err();
        assert_eq!(av.status, 404);
        // 9. Cleanup of the second account.
        request(&configured_base().unwrap(), "DELETE", "/v1/me", Some(&other_token), Body::None).unwrap();
        println!("requests sent: {}", request_count());
        let _ = std::fs::remove_dir_all(&tmp);
    }

}
