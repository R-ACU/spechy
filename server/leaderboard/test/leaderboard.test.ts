import { describe, expect, it } from "vitest";
import { isoWeek, weekKeyStart } from "../src/lib/time";
import { runDaily } from "../src/cron";
import { env } from "cloudflare:test";
import { call, freshWeek, joinPlayer, score } from "./helpers";

describe("leaderboard", () => {
  it("orders by value, ties go to whoever reached it first", async () => {
    const now = freshWeek();
    const a = await joinPlayer("Alpha", now);
    const b = await joinPlayer("Bravo", now);
    const c = await joinPlayer("Charlie", now);
    const d = await joinPlayer("Delta", now); // joins but scores nothing
    await score(a.token, { points: 300, words: 10 }, now + 1);
    await score(b.token, { points: 500, words: 30 }, now + 2);
    await score(c.token, { points: 300, words: 20 }, now + 3); // same points as Alpha, but later

    const r = await call("GET", "/v1/leaderboard?cat=overall", { token: c.token, now: now + 10 });
    expect(r.status).toBe(200);
    expect(r.json.week.key).toBe(isoWeek(now));
    expect(r.json.total).toBe(3);
    expect(r.json.rows.map((x: any) => [x.rank, x.name, x.value, x.me])).toEqual([
      [1, "Bravo", 500, false],
      [2, "Alpha", 300, false],
      [3, "Charlie", 300, true],
    ]);
    expect(r.json.me).toMatchObject({ rank: 3, name: "Charlie", value: 300, me: true });

    const words = await call("GET", "/v1/leaderboard?cat=words", { token: a.token, now: now + 10 });
    expect(words.json.rows.map((x: any) => x.name)).toEqual(["Bravo", "Charlie", "Alpha"]);

    // players without a value are not listed, but still get their own row
    const none = await call("GET", "/v1/leaderboard?cat=overall", { token: d.token, now: now + 10 });
    expect(none.json.rows).toHaveLength(3);
    expect(none.json.me).toMatchObject({ rank: null, value: 0, name: "Delta" });
  });

  it("ranks games by the weekly best", async () => {
    const now = freshWeek();
    const a = await joinPlayer("Towerman", now);
    const b = await joinPlayer("Snakeman", now);
    await score(a.token, { games: [{ game: "tower", score: 40 }, { game: "snake", score: 2 }] }, now);
    await score(b.token, { games: [{ game: "tower", score: 41 }] }, now);
    await score(a.token, { games: [{ game: "tower", score: 10 }] }, now + 5);

    const t = await call("GET", "/v1/leaderboard?cat=tower", { token: a.token, now: now + 10 });
    expect(t.json.rows.map((x: any) => [x.name, x.value])).toEqual([["Snakeman", 41], ["Towerman", 40]]);
    const s = await call("GET", "/v1/leaderboard?cat=snake", { token: b.token, now: now + 10 });
    expect(s.json.rows.map((x: any) => x.name)).toEqual(["Towerman"]);
    expect(s.json.me.rank).toBeNull();
    const c = await call("GET", "/v1/leaderboard?cat=comet", { token: b.token, now: now + 10 });
    expect(c.json.rows).toEqual([]);
  });

  it("returns the top 100 plus the caller's row when outside", async () => {
    const now = freshWeek();
    const players = [];
    for (let i = 0; i < 101; i++) players.push(await joinPlayer(`Runner ${String(i).padStart(3, "0")}`, now));
    // Runner 000 scores most, Runner 100 least
    for (let i = 0; i < 101; i++) await score(players[i].token, { points: 2000 - i }, now + i);
    const last = players[100];
    const r = await call("GET", "/v1/leaderboard", { token: last.token, now: now + 1000 });
    expect(r.json.cat).toBe("overall");
    expect(r.json.total).toBe(101);
    expect(r.json.rows).toHaveLength(100);
    expect(r.json.rows[0]).toMatchObject({ rank: 1, name: "Runner 000", value: 2000 });
    expect(r.json.rows[99]).toMatchObject({ rank: 100, name: "Runner 099" });
    expect(r.json.rows.some((x: any) => x.me)).toBe(false);
    expect(r.json.me).toMatchObject({ rank: 101, name: "Runner 100", value: 1900 });
  });

  it("validates cat and week", async () => {
    const p = await joinPlayer("Validator");
    expect((await call("GET", "/v1/leaderboard?cat=coins", { token: p.token })).status).toBe(400);
    expect((await call("GET", "/v1/leaderboard?week=2026-47", { token: p.token })).status).toBe(400);
    expect((await call("GET", "/v1/leaderboard?week=2099-W01", { token: p.token })).status).toBe(400);
    expect((await call("GET", "/v1/leaderboard")).status).toBe(401);
  });
});

describe("weekly rollover", () => {
  it("computes ISO weeks in UTC", () => {
    expect(isoWeek(Date.UTC(2026, 10, 18))).toBe("2026-W47");
    expect(isoWeek(Date.UTC(2025, 11, 29))).toBe("2026-W01");
    expect(isoWeek(Date.UTC(2026, 11, 31))).toBe("2026-W53");
    expect(isoWeek(Date.UTC(2027, 0, 3, 23, 59, 59))).toBe("2026-W53");
    expect(isoWeek(Date.UTC(2027, 0, 4))).toBe("2027-W01");
    expect(weekKeyStart("2026-W47")).toBe(Date.UTC(2026, 10, 16));
    expect(weekKeyStart("2027-W53")).toBeNull();
  });

  it("starts an empty week on Monday 00:00 UTC and keeps the old one as history", async () => {
    // Sunday 2031-03-16 23:59:59 UTC, the last second of 2031-W11
    const sunday = Date.UTC(2031, 2, 16, 23, 59, 59);
    const monday = Date.UTC(2031, 2, 17, 0, 0, 0);
    expect(isoWeek(sunday)).toBe("2031-W11");
    expect(isoWeek(monday)).toBe("2031-W12");

    const a = await joinPlayer("Weekender", sunday - 3600_000);
    const b = await joinPlayer("Mondayer", sunday - 3600_000);
    await score(a.token, { points: 900, games: [{ game: "comet", score: 50 }] }, sunday);
    await score(b.token, { points: 400 }, sunday);

    const before = await call("GET", "/v1/leaderboard", { token: a.token, now: sunday });
    expect(before.json.rows.map((x: any) => x.name)).toEqual(["Weekender", "Mondayer"]);
    expect(before.json.week.endsAt).toBe(new Date(monday).toISOString());

    const after = await call("GET", "/v1/leaderboard", { token: a.token, now: monday });
    expect(after.json.week.key).toBe("2031-W12");
    expect(after.json.rows).toEqual([]);
    expect(after.json.me).toMatchObject({ rank: null, value: 0 });

    // last week's final standing is still there (for the Monday payout in the app)
    const me = await call("GET", "/v1/me", { token: a.token, now: monday });
    expect(me.json.thisWeek).toMatchObject({ points: 0, rank: null });
    expect(me.json.lastWeek).toMatchObject({ key: "2031-W11", points: 900, comet: 50, rank: 1 });
    expect(me.json.player.bests.comet).toBe(50); // all-time bests survive the reset

    const history = await call("GET", "/v1/leaderboard?week=2031-W11", { token: b.token, now: monday });
    expect(history.json.week.current).toBe(false);
    expect(history.json.rows.map((x: any) => [x.name, x.value])).toEqual([["Weekender", 900], ["Mondayer", 400]]);
    expect(history.json.me.rank).toBe(2);

    // new points land in the new week only
    await score(b.token, { points: 10 }, monday + 1000);
    const fresh = await call("GET", "/v1/leaderboard", { token: b.token, now: monday + 2000 });
    expect(fresh.json.rows.map((x: any) => [x.name, x.value])).toEqual([["Mondayer", 10]]);
  });
});

describe("daily cron", () => {
  it("prunes counters and deletes abandoned accounts with their pictures", async () => {
    const t0 = Date.UTC(2020, 0, 6, 12);
    const stale = await joinPlayer("Ghost", t0);
    await env.AVATARS.put(`avatars/${stale.id}/1.png`, "x");
    const active = await joinPlayer("Regular", t0 + 200 * 86_400_000);
    const now = t0 + 240 * 86_400_000;

    const res = await runDaily(env, now);
    expect(res.deletedPlayers).toBeGreaterThanOrEqual(1);
    expect(await env.DB.prepare("SELECT id FROM players WHERE id = ?1").bind(stale.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM players WHERE id = ?1").bind(active.id).first()).not.toBeNull();
    expect((await env.AVATARS.list({ prefix: `avatars/${stale.id}/` })).objects).toHaveLength(0);
    const old = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE window < ?1").bind(Math.floor((now - 2 * 86_400_000) / 1000)).first<{ n: number }>();
    expect(old!.n).toBe(0);
  });
});
