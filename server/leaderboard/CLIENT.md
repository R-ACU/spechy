# Wiring the Spechy app to the leaderboard

For whoever builds the Tauri side. API details: [README.md](README.md). Errors always come as
`{ "error": { "code", "message", "details"? } }`.

## Ground rules

1. **No request before Join.** Not the leaderboard, not pictures, not a health check. The
   Leaderboard tab shows a local preview plus a Join button until the user opts in
   (Profile > "Join the leaderboard", off by default).
2. **Call from Rust** (`reqwest` in a Tauri command) rather than `fetch` in the WebView. Then
   no CORS is involved and the token never sits in WebView JavaScript. If you do call from the
   WebView, the origins allowed by default are `http://tauri.localhost` (Windows),
   `tauri://localhost` (Linux/macOS) and the Vite dev server `http://127.0.0.1:1433`.
3. **Store the token** in the app data folder next to `settings.json` (for example
   `leaderboard.json`: `{ "baseUrl", "playerId", "token" }`), never in exports, logs or crash
   reports. Treat it like a password.
4. **Headers** on every call after Join:
   ```
   Authorization: Bearer spk_...
   Content-Type: application/json        (JSON bodies)
   ```
5. **Base URL** is a build constant (production suggestion `https://leaderboard.remos.systems`,
   local `http://127.0.0.1:8787` with `npm run dev` in `server/leaderboard`).

## Flow: Join

```
POST /v1/join
{ "name": "Remo", "titleId": "night-owl", "tier": 2, "division": 1, "rp": 92 }
→ 201 { "token": "spk_...", "player": { "id": "p_...", ... }, "week": {...}, "thisWeek": {...}, "lastWeek": null }
```

- Save `token` and `player.id` immediately; the token is shown only once.
- `400 validation_failed` with `details.reason` = `length` | `characters` | `profanity` | `reserved`:
  show it at the name field.
- `429 rate_limited`: show "Try again later" (`Retry-After` seconds).
- Optional picture right after: `PUT /v1/me/avatar` (below).

## Flow: sync after each game (and periodically)

Keep a local outbox of what has not been sent yet: points and words earned since the last
successful sync, plus finished game results. Send it after every game (also when the player
quits early) and every few minutes while dictating, at most once a minute.

```
POST /v1/scores
{
  "batchId": "5f0c2e9a-...",          // new UUID per outbox snapshot, REUSE it when retrying
  "points": 120,                     // delta since last sync, 0..5000
  "words": 340,                      // delta since last sync, 0..20000
  "games": [ { "game": "tower", "score": 42 } ]   // tower | snake | comet, up to 20
}
→ 200 { "duplicate": false, "accepted": { "points": 120, "words": 340, "games": 1 }, "capped": false,
        "player": {...}, "week": {...}, "thisWeek": { "points", "words", "tower", "snake", "comet", "rank" }, "lastWeek": {...} }
```

- On a network error or 5xx, retry later with the **same** `batchId`; the server never counts a
  batch twice (`duplicate: true`).
- On 200, clear exactly what was in that batch from the outbox.
- `capped: true` means the daily cap was hit; the rest is dropped server-side, clear it locally too.
- Larger deltas than the per-request limit: split into several batches.
- Week boundaries: the server books a batch into the week of its arrival time (UTC). Sync
  before Monday 00:00 UTC if you can; late batches count for the new week.

## Profile changes

`PUT /v1/me` with only the changed fields whenever the name, the equipped title or the rank
changes: `{ "titleId": "champion" }`, `{ "tier": 3, "division": 0, "rp": 10 }`. `titleId: null`
unequips.

## Picture

```
PUT /v1/me/avatar
Content-Type: image/png | image/jpeg | image/webp
<raw bytes>
```

Crop to a square and downscale to 256 x 256 in the app before upload (allowed: 32 to 1024 px,
max 256 KB). Errors: `415` wrong format, `400` not square or wrong size, `413` too large,
`403 avatar_locked` (moderation hid the current picture). `DELETE /v1/me/avatar` removes it.

## Showing the leaderboard

```
GET /v1/leaderboard?cat=overall     (overall | words | tower | snake | comet)
→ { "cat", "week": { "key", "startsAt", "endsAt", "current" }, "total",
    "rows": [ { "rank", "id", "name", "titleId", "tier", "division", "rp", "value", "avatar", "me" } ],
    "me": { ...same fields, "rank": null if no value yet, "hidden" } }
```

- `week.endsAt` drives "Ends in 4 days, 9 hours".
- Render `me` pinned below the list when it is not among `rows`.
- `avatar` is a path like `/v1/avatar/p_...?v=3` or null (show the initial). Pictures need the
  bearer header, so `<img src>` does not work directly: fetch the bytes in Rust (or `fetch`
  with the header), cache them on disk keyed by the full path including `?v=`, and show them as
  a data/blob URL. A new `v` means a new picture.
- Refresh when the tab opens and after a sync, not on a timer.

## Monday payout

`GET /v1/me` → `lastWeek: { key, points, words, tower, snake, comet, rank }`. When
`lastWeek.key` differs from the last paid week stored locally, pay coins for `lastWeek.rank`
(base values Rank 1: 150, 2: 100, 3: 60; the app applies its earnings boost, see `EARN_BOOST_PERCENT` in `src-tauri/src/economy.rs`) and remember the key.

## Report

Row menu "Report name" / "Report picture":

```
POST /v1/report   { "playerId": "p_...", "kind": "name" | "avatar" | "player", "note": "optional, max 200" }
→ 202 { "ok": true, "duplicate": false, "avatarHidden": false }
```

Hide the reported picture locally right away. Own row: no report button (server answers 400).

## Leave

Profile > "Join the leaderboard" off → confirm dialog ("Removes your name, scores and picture
from the server") →

```
DELETE /v1/me   → 204
```

Then delete `leaderboard.json` and the picture cache, and stop every call. A `401` on any call
means the account is gone (left on another device, removed by moderation, or inactive for 180
days): delete the local token and show the Join state again. On a network error while leaving,
keep a "pending leave" flag and retry on the next start before anything else.

## Moderation state

`GET /v1/me` → `player.moderation: { hidden, avatarHidden }`. If `hidden`, the player is not
visible to others; show a short notice in Profile. If `avatarHidden`, the picture is hidden and
uploads are locked until reviewed.
