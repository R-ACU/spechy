import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/limits";
import { ADMIN, call, freshWeek, jpeg, joinPlayer, png, score, webpLossless, webpVp8x } from "./helpers";

const upload = (token: string, bytes: Uint8Array, type = "image/png") =>
  call("PUT", "/v1/me/avatar", { token, raw: bytes, headers: { "Content-Type": type } });

describe("avatar upload", () => {
  it("stores a square PNG in R2 and serves it to members with cache headers", async () => {
    const p = await joinPlayer("Pictured");
    const viewer = await joinPlayer("Viewer");
    const bytes = png(128, 128);
    const up = await upload(p.token, bytes);
    expect(up.status).toBe(200);
    expect(up.json.player.avatar).toBe(`/v1/avatar/${p.id}?v=1`);
    const row = await env.DB.prepare("SELECT avatar_key FROM players WHERE id = ?1").bind(p.id).first<{ avatar_key: string }>();
    expect(await env.AVATARS.head(row!.avatar_key)).not.toBeNull();

    const got = await call("GET", `/v1/avatar/${p.id}`, { token: viewer.token });
    expect(got.status).toBe(200);
    expect(got.res.headers.get("Content-Type")).toBe("image/png");
    expect(got.res.headers.get("Cache-Control")).toBe(`private, max-age=${LIMITS.avatar.cacheSeconds}`);
    expect(got.res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await got.res.arrayBuffer())).toEqual(bytes);

    const etag = got.res.headers.get("ETag")!;
    const cached = await call("GET", `/v1/avatar/${p.id}`, { token: viewer.token, headers: { "If-None-Match": etag } });
    expect(cached.status).toBe(304);

    // only members can pull pictures
    expect((await call("GET", `/v1/avatar/${p.id}`)).status).toBe(401);
  });

  it("replaces the old object on a new upload and deletes it on DELETE", async () => {
    const p = await joinPlayer("Replacer");
    await upload(p.token, png(64, 64));
    const first = (await env.AVATARS.list({ prefix: `avatars/${p.id}/` })).objects.map((o) => o.key);
    const second = await upload(p.token, jpeg(200, 200), "image/jpeg");
    expect(second.json.player.avatar).toBe(`/v1/avatar/${p.id}?v=2`);
    const keys = (await env.AVATARS.list({ prefix: `avatars/${p.id}/` })).objects.map((o) => o.key);
    expect(keys).toEqual([`avatars/${p.id}/2.jpg`]);
    expect(keys).not.toEqual(first);

    const del = await call("DELETE", "/v1/me/avatar", { token: p.token });
    expect(del.json.player.avatar).toBeNull();
    expect((await env.AVATARS.list({ prefix: `avatars/${p.id}/` })).objects).toHaveLength(0);
  });

  it.each([
    ["JPEG", jpeg(96, 96)],
    ["WEBP extended", webpVp8x(300, 300)],
    ["WEBP lossless", webpLossless(512, 512)],
  ])("accepts %s", async (_n, bytes) => {
    const p = await joinPlayer("Formats");
    expect((await upload(p.token, bytes, "application/octet-stream")).status).toBe(200);
  });

  it("checks magic bytes, not the declared type", async () => {
    const p = await joinPlayer("Sneaky");
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const r1 = await upload(p.token, svg, "image/png");
    expect(r1.status).toBe(415);
    expect(r1.json.error.code).toBe("unsupported_media_type");
    const gif = new TextEncoder().encode("GIF89a" + "\0".repeat(40));
    expect((await upload(p.token, gif, "image/gif")).status).toBe(415);
  });

  it("rejects non-square, too small, too big and empty pictures", async () => {
    const p = await joinPlayer("Shapes");
    const wide = await upload(p.token, png(200, 100));
    expect(wide.status).toBe(400);
    expect(wide.json.error.details).toEqual({ width: 200, height: 100 });
    expect((await upload(p.token, webpVp8x(300, 299))).status).toBe(400);
    expect((await upload(p.token, png(16, 16))).status).toBe(400);
    expect((await upload(p.token, png(2048, 2048))).status).toBe(400);
    const huge = await upload(p.token, png(128, 128, LIMITS.avatar.maxBytes + 1));
    expect(huge.status).toBe(413);
    expect(huge.json.error.code).toBe("payload_too_large");
    expect((await upload(p.token, new Uint8Array())).status).toBe(400);
  });
});

describe("reports and moderation", () => {
  it("hides a picture automatically after enough distinct avatar reports", async () => {
    const target = await joinPlayer("Reported");
    await upload(target.token, png(64, 64));
    const reporters = [await joinPlayer("Rep One"), await joinPlayer("Rep Two"), await joinPlayer("Rep Three")];

    const first = await call("POST", "/v1/report", { token: reporters[0].token, body: { playerId: target.id, kind: "avatar", note: "rude" } });
    expect(first.status).toBe(202);
    expect(first.json).toEqual({ ok: true, duplicate: false, avatarHidden: false });
    const dup = await call("POST", "/v1/report", { token: reporters[0].token, body: { playerId: target.id, kind: "avatar" } });
    expect(dup.json.duplicate).toBe(true); // the same reporter never counts twice
    await call("POST", "/v1/report", { token: reporters[1].token, body: { playerId: target.id, kind: "avatar" } });
    const third = await call("POST", "/v1/report", { token: reporters[2].token, body: { playerId: target.id, kind: "avatar" } });
    expect(third.json.avatarHidden).toBe(true);

    expect((await call("GET", `/v1/avatar/${target.id}`, { token: reporters[0].token })).status).toBe(404);
    expect((await call("GET", `/v1/avatar/${target.id}`, { token: target.token })).status).toBe(404); // not even to the owner
    const me = await call("GET", "/v1/me", { token: target.token });
    expect(me.json.player.avatar).toBeNull();
    expect(me.json.player.moderation.avatarHidden).toBe(true);
    const locked = await upload(target.token, png(64, 64));
    expect(locked.status).toBe(403);
    expect(locked.json.error.code).toBe("avatar_locked");

    // the admin can still review it, and lift the lock
    const review = await call("GET", `/v1/admin/avatar/${target.id}`, { token: ADMIN });
    expect(review.status).toBe(200);
    expect(review.res.headers.get("Cache-Control")).toBe("no-store");
    const lift = await call("POST", `/v1/admin/players/${target.id}/moderate`, { token: ADMIN, body: { avatarHidden: false } });
    expect(lift.json.player.avatarHidden).toBe(false);
    expect((await call("GET", `/v1/avatar/${target.id}`, { token: reporters[0].token })).status).toBe(200);
    const open = await call("GET", "/v1/admin/reports?status=open", { token: ADMIN });
    expect(open.json.reports.filter((r: any) => r.targetId === target.id)).toEqual([]);
  });

  it("validates reports", async () => {
    const p = await joinPlayer("Reporter");
    expect((await call("POST", "/v1/report", { token: p.token, body: { playerId: p.id, kind: "name" } })).status).toBe(400);
    expect((await call("POST", "/v1/report", { token: p.token, body: { playerId: "p_0000000000000000", kind: "name" } })).status).toBe(404);
    expect((await call("POST", "/v1/report", { token: p.token, body: { playerId: "x", kind: "name" } })).status).toBe(400);
    const other = await joinPlayer("Other");
    expect((await call("POST", "/v1/report", { token: p.token, body: { playerId: other.id, kind: "spam" } })).status).toBe(400);
    expect((await call("POST", "/v1/report", { token: p.token, body: { playerId: other.id, kind: "name", note: "x".repeat(201) } })).status).toBe(400);
  });

  it("lets the admin hide a player, who then vanishes for everyone else", async () => {
    const now = freshWeek();
    const bad = await joinPlayer("Troublemaker", now);
    const good = await joinPlayer("Goodie", now);
    await upload(bad.token, png(64, 64));
    await score(bad.token, { points: 999 }, now);
    await score(good.token, { points: 5 }, now);
    const rep = await call("POST", "/v1/report", { token: good.token, body: { playerId: bad.id, kind: "name" }, now });
    expect(rep.status).toBe(202);

    const reports = await call("GET", "/v1/admin/reports", { token: ADMIN });
    const mine = reports.json.reports.find((r: any) => r.targetId === bad.id);
    expect(mine).toMatchObject({ kind: "name", status: "open", targetName: "Troublemaker", reporterId: good.id });

    const hide = await call("POST", `/v1/admin/players/${bad.id}/moderate`, { token: ADMIN, body: { hidden: true, resetName: true }, now });
    expect(hide.status).toBe(200);
    expect(hide.json.player.hidden).toBe(true);
    expect(hide.json.player.name).toMatch(/^Speaker \d{4}$/);

    const board = await call("GET", "/v1/leaderboard", { token: good.token, now: now + 1 });
    expect(board.json.rows.map((x: any) => x.name)).toEqual(["Goodie"]);
    expect(board.json.me.rank).toBe(1);
    expect((await call("GET", `/v1/avatar/${bad.id}`, { token: good.token })).status).toBe(404);
    expect((await call("POST", "/v1/report", { token: good.token, body: { playerId: bad.id, kind: "player" } })).status).toBe(404);

    // the hidden player still sees their own state, flagged
    const own = await call("GET", "/v1/leaderboard", { token: bad.token, now: now + 1 });
    expect(own.json.me).toMatchObject({ hidden: true, rank: null });
    const resolved = await call("GET", "/v1/admin/reports?status=resolved", { token: ADMIN });
    expect(resolved.json.reports.find((r: any) => r.targetId === bad.id)?.status).toBe("resolved");
  });

  it("guards the admin API", async () => {
    const p = await joinPlayer("Wannabe");
    expect((await call("GET", "/v1/admin/reports")).status).toBe(401);
    expect((await call("GET", "/v1/admin/reports", { token: p.token })).status).toBe(401);
    expect((await call("GET", "/v1/admin/reports", { token: "wrong" })).status).toBe(401);
    const off = await call("GET", "/v1/admin/reports", { token: ADMIN, envOverride: { ADMIN_TOKEN: undefined } });
    expect(off.status).toBe(503);
    expect(off.json.error.code).toBe("admin_disabled");
    expect((await call("GET", `/v1/admin/players/${p.id}`, { token: ADMIN })).json.player.name).toBe("Wannabe");
    const bad = await call("POST", `/v1/admin/players/${p.id}/moderate`, { token: ADMIN, body: { hidden: "yes" } });
    expect(bad.status).toBe(400);
  });
});

describe("leaving", () => {
  it("DELETE /v1/me removes the player, scores, reports and picture completely", async () => {
    const now = freshWeek();
    const p = await joinPlayer("Leaver", now);
    const other = await joinPlayer("Stayer", now);
    await upload(p.token, png(64, 64));
    await score(p.token, { points: 10, games: [{ game: "snake", score: 4 }] }, now);
    await call("POST", "/v1/report", { token: p.token, body: { playerId: other.id, kind: "name" }, now });
    await call("POST", "/v1/report", { token: other.token, body: { playerId: p.id, kind: "avatar" }, now });

    const del = await call("DELETE", "/v1/me", { token: p.token, now });
    expect(del.status).toBe(204);

    expect((await call("GET", "/v1/me", { token: p.token })).status).toBe(401);
    for (const [table, col] of [["players", "id"], ["weekly_scores", "player_id"], ["daily_usage", "player_id"], ["score_batches", "player_id"]]) {
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?1`).bind(p.id).first<{ n: number }>();
      expect(n!.n, table).toBe(0);
    }
    const reps = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ?1 OR target_id = ?1").bind(p.id).first<{ n: number }>();
    expect(reps!.n).toBe(0);
    expect((await env.AVATARS.list({ prefix: `avatars/${p.id}/` })).objects).toHaveLength(0);
    const board = await call("GET", "/v1/leaderboard", { token: other.token, now: now + 1 });
    expect(board.json.rows).toEqual([]);
  });

  it("admin delete removes a player the same way", async () => {
    const p = await joinPlayer("Removed");
    await upload(p.token, png(64, 64));
    expect((await call("DELETE", `/v1/admin/players/${p.id}`, { token: ADMIN })).status).toBe(204);
    expect((await call("GET", "/v1/me", { token: p.token })).status).toBe(401);
    expect((await env.AVATARS.list({ prefix: `avatars/${p.id}/` })).objects).toHaveLength(0);
  });
});
