# Spechy leaderboard server

Backend for the opt-in weekly leaderboard of the Spechy desktop app: a Cloudflare Worker with
D1 (SQL) for players and scores and R2 for profile pictures.

Coins, the shop and title boxes stay local in the app. The server only knows what a player
chose to share. How the app should talk to it: [CLIENT.md](CLIENT.md).

## Layout

```
server/leaderboard/
  wrangler.toml          Worker config, placeholder ids, deploy notes
  migrations/0001_init.sql
  src/
    index.ts             router, CORS, global rate limit, error handling, cron entry
    limits.ts            every sanity limit and rate limit in one place
    profanity.ts         name filter word list (extend here)
    cron.ts              daily housekeeping
    lib/                 http helpers, ISO weeks, crypto, image sniffing, players, rate limiting, validation
    routes/              player (join, me, scores), avatar, leaderboard, report, admin
  test/                  vitest suite, runs inside workerd with local D1 and R2
  CLIENT.md              integration guide for the Tauri app
```

## Run locally

Always run wrangler from this folder: it reads `.env` from the current directory, and the
AI-OS root holds an unrelated one.

```sh
npm install
npm test                     # vitest inside the Workers runtime (Miniflare), local D1 + R2
npm run typecheck
cp .dev.vars.example .dev.vars
npm run db:migrate:local     # creates the local D1 under .wrangler/
npm run dev                  # wrangler dev --local, http://127.0.0.1:8787
```

Nothing here needs a Cloudflare account. `wrangler dev --local` never deploys.

Note: `npm test` sometimes prints "uncaught exception ... Expected global Vitest state" before
the first test when several test files start in parallel. That comes from
`@cloudflare/vitest-plugin` probing the Worker at startup, not from this code; the run still
passes and exits 0.

## Privacy model

- **Opt-in.** The app calls the server only after the user presses Join. Before that, nothing
  is fetched, not even other players' pictures.
- **Anonymous.** No e-mail, no password, no device id. `POST /v1/join` returns a random public
  id (`p_` + 16 hex) and a secret bearer token (`spk_` + 256 random bits). Only the SHA-256 of
  the token is stored. Lose the token, lose the account (it is deleted after 180 days without a
  request, `INACTIVE_DELETE_DAYS`).
- **Stored per player:** display name, equipped title id, rank tier/division/RP, all-time bests
  for Pixel Tower, Voice Snake and Comet Keeper, an optional picture, timestamps, the last day
  seen. Per ISO week: points, words, weekly game bests. Never dictated text, never app usage.
- **IP addresses** are never stored. Rate-limit keys use a salted SHA-256 of the IP
  (`IP_HASH_SALT`), counters are pruned after two days.
- **Leaving = gone.** `DELETE /v1/me` deletes the player row, all weeks, daily counters,
  idempotency keys, reports filed by or against them, rate-limit counters and every picture
  object in R2.
- **Pictures are members-only.** `GET /v1/avatar/:id` needs a player token; served with
  `Cache-Control: private`. Hidden pictures and hidden players are never served to anyone.
- **History:** weeks older than 52 weeks are deleted by the daily cron.

## API (v1)

Base URL in production: suggestion `https://leaderboard.remos.systems`. All bodies are JSON
(`Content-Type: application/json`, max 8 KB) except the picture upload. Player endpoints need
`Authorization: Bearer <token>`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/health` | none | liveness, current ISO week |
| POST | `/v1/join` | none | create player `{ name?, titleId?, tier?, division?, rp? }` → `201 { token, player, week, thisWeek, lastWeek }` |
| GET | `/v1/me` | player | own profile, this week (with overall rank), last week (for the Monday payout) |
| PUT | `/v1/me` | player | partial update `{ name?, titleId?, tier?, division?, rp? }`, unknown fields are rejected |
| DELETE | `/v1/me` | player | leave, deletes everything → `204` |
| POST | `/v1/scores` | player | `{ batchId, points?, words?, games?: [{ game, score }] }` → accepted amounts + fresh `me` |
| PUT | `/v1/me/avatar` | player | raw PNG/JPEG/WEBP bytes, square, 32 to 1024 px, max 256 KB |
| DELETE | `/v1/me/avatar` | player | remove picture |
| GET | `/v1/leaderboard?cat=&week=` | player | `cat` = `overall` (weekly points), `words`, `tower`, `snake`, `comet`; `week` optional `YYYY-Www` for history. Top 100 plus `me` |
| GET | `/v1/avatar/:id` | player | picture bytes, `ETag`, `If-None-Match` → 304 |
| POST | `/v1/report` | player | `{ playerId, kind: "name" \| "avatar" \| "player", note? }` → `202` |
| GET | `/v1/admin/reports?status=open\|resolved\|all` | admin | report queue |
| POST | `/v1/admin/reports/:id/resolve` | admin | close one report |
| GET | `/v1/admin/players/:id` | admin | full player incl. moderation flags |
| POST | `/v1/admin/players/:id/moderate` | admin | `{ hidden?, avatarHidden?, resetName?, resolveReports? (default true) }` |
| GET | `/v1/admin/avatar/:id` | admin | review a picture even if hidden (`no-store`) |
| DELETE | `/v1/admin/players/:id` | admin | delete a player completely |

**Errors** always look like `{ "error": { "code": "validation_failed", "message": "...", "details": { "field": "points" } } }`.
Codes: `validation_failed`, `invalid_json`, `unsupported_media_type`, `payload_too_large`,
`unauthorized`, `origin_not_allowed`, `avatar_locked`, `not_found`, `method_not_allowed`,
`rate_limited` (with `Retry-After`), `admin_disabled`, `internal_error`.

**Leaderboard order:** value descending, ties go to whoever reached the value first, then id.
Rows: `{ rank, id, name, titleId, tier, division, rp, value, avatar, me }`. Only players with a
value above 0 are listed; `me` is always returned (`rank: null` without a value), plus
`hidden: true` if moderation hid the caller.

**Weekly reset:** Monday 00:00 UTC. Every score row is keyed by ISO week (`2026-W47`), so the
new week simply starts empty (lazy rollover, no job needed) and old weeks stay readable with
`?week=`. The daily cron (`17 0 * * *`) only prunes.

## Limits (src/limits.ts)

| What | Limit |
| --- | --- |
| Name | 3 to 20 characters, letters/digits/space/`_.-`, profanity list, reserved names |
| Title id | `^[a-z0-9][a-z0-9_-]{0,31}$` or null |
| Rank | tier 0..6, division 0..2, rp 0..100 |
| Scores per request | 5,000 points, 20,000 words, 20 game results (over → 400) |
| Scores per UTC day | 50,000 points, 60,000 words, 400 game results (over → clamped, `capped: true`) |
| Max single result | Tower 10,000, Snake 5,000, Comet 1,000,000 |
| Rate limits | 600/min per IP, 240/min per token, 5 joins/h per IP, 60 score syncs/h, 10 uploads/day, 30 reports/day, 30 profile edits/h |
| Auto-hide | 3 distinct open avatar reports hide the picture until reviewed (`AUTO_HIDE_AVATAR_REPORTS`, `0` = off) |

The server trusts the client for points, ranks and game results: it only enforces sanity
bounds. A modified client can still post fake but plausible scores. That is the price of
keeping the economy local.

### Rate limiting

Fixed-window counters in D1 (`rate_limits`). Simple and identical in tests, local dev and
production, but every request costs two small D1 writes (IP and token). If traffic grows, swap
`hit()` in `src/lib/ratelimit.ts` for the Workers Rate Limiting binding
(`[[ratelimits]]` in wrangler.toml, check the current Cloudflare docs for the syntax) and keep the D1 path as local fallback.

## Moderation

1. Look at the queue: `curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/v1/admin/reports`
2. Review a picture: `GET /v1/admin/avatar/<id>`
3. Act: `POST /v1/admin/players/<id>/moderate` with `{"avatarHidden": true}`, `{"hidden": true}`
   or `{"resetName": true}`; this resolves the open reports of that player. `{"avatarHidden": false}`
   lifts an auto-hide. Hidden pictures also lock new uploads (`403 avatar_locked`).
4. Or delete outright: `DELETE /v1/admin/players/<id>`.

Without the `ADMIN_TOKEN` secret every admin endpoint answers `503 admin_disabled`.

## Deploy later (not done yet)

Run everything from this folder.

```sh
npx wrangler login                                   # once, interactive
npx wrangler d1 create spechy-leaderboard            # paste database_id into wrangler.toml
npx wrangler r2 bucket create spechy-avatars
npx wrangler d1 migrations apply spechy-leaderboard --remote
npx wrangler secret put ADMIN_TOKEN                  # long random string
npx wrangler secret put IP_HASH_SALT                 # another random string
# uncomment [[routes]] in wrangler.toml (custom domain, e.g. leaderboard.remos.systems)
npx wrangler deploy
```

Then put the base URL into the app build and check `ALLOWED_ORIGINS` (only matters if the app
calls from the WebView instead of Rust). The free Workers plan covers D1, R2 and cron for a
small player base; R2 has no egress fees.
