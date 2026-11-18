import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/limits";
import { call, freshWeek, joinPlayer, score } from "./helpers";

const HOUR = 3_600_000;

describe("score submission", () => {
  it("adds weekly points and words and keeps game bests", async () => {
    const now = freshWeek();
    const p = await joinPlayer("Scorer", now);
    const a = await score(p.token, { points: 120, words: 340, games: [{ game: "tower", score: 12 }, { game: "tower", score: 30 }] }, now);
    expect(a.status).toBe(200);
    expect(a.json.accepted).toEqual({ points: 120, words: 340, games: 2 });
    expect(a.json.capped).toBe(false);
    expect(a.json.thisWeek).toMatchObject({ points: 120, words: 340, tower: 30, snake: 0, rank: 1 });
    expect(a.json.player.bests.tower).toBe(30);

    // a worse result never lowers the best, points keep adding up
    const b = await score(p.token, { points: 80, games: [{ game: "tower", score: 5 }, { game: "comet", score: 900 }] }, now + HOUR);
    expect(b.json.thisWeek).toMatchObject({ points: 200, words: 340, tower: 30, comet: 900 });
    expect(b.json.player.bests).toEqual({ tower: 30, snake: 0, comet: 900 });
  });

  it("is idempotent per batchId", async () => {
    const now = freshWeek();
    const p = await joinPlayer("Retrier", now);
    const body = { batchId: "retry-batch-0001", points: 50, words: 10 };
    const first = await call("POST", "/v1/scores", { token: p.token, body, now });
    const again = await call("POST", "/v1/scores", { token: p.token, body, now });
    expect(first.json.duplicate).toBe(false);
    expect(again.status).toBe(200);
    expect(again.json.duplicate).toBe(true);
    expect(again.json.thisWeek.points).toBe(50);
  });

  it.each([
    [{ points: LIMITS.scores.perRequest.points + 1 }, "points"],
    [{ words: -1 }, "words"],
    [{ points: 1.5 }, "points"],
    [{ games: [{ game: "tetris", score: 1 }] }, "games[0].game"],
    [{ games: [{ game: "tower", score: LIMITS.scores.maxGameScore.tower + 1 }] }, "games[0].score"],
    [{ games: new Array(LIMITS.scores.perRequest.games + 1).fill({ game: "snake", score: 1 }) }, "games"],
  ])("rejects over-limit requests %j", async (body, field) => {
    const p = await joinPlayer("Cheater", freshWeek());
    const r = await score(p.token, body);
    expect(r.status).toBe(400);
    expect(r.json.error.details.field).toBe(field);
  });

  it("requires a batchId", async () => {
    const p = await joinPlayer("NoBatch");
    const r = await call("POST", "/v1/scores", { token: p.token, body: { points: 1 } });
    expect(r.status).toBe(400);
    expect(r.json.error.details.field).toBe("batchId");
  });

  it("clamps at the daily cap and starts fresh the next UTC day", async () => {
    const now = freshWeek(); // Wednesday noon
    const p = await joinPlayer("Grinder", now);
    const max = LIMITS.scores.perRequest.points;
    const perDay = LIMITS.scores.perDay.points;
    let total = 0;
    for (let i = 0; total + max <= perDay; i++) {
      const r = await score(p.token, { points: max }, now + i * 1000);
      expect(r.json.capped).toBe(false);
      total += max;
    }
    expect(total).toBe(perDay);
    const over = await score(p.token, { points: 100, words: 5 }, now + 60_000);
    expect(over.status).toBe(200);
    expect(over.json.capped).toBe(true);
    expect(over.json.accepted).toEqual({ points: 0, words: 5, games: 0 });
    expect(over.json.thisWeek.points).toBe(perDay);

    const tomorrow = await score(p.token, { points: 100 }, now + 24 * HOUR);
    expect(tomorrow.json.accepted.points).toBe(100);
    expect(tomorrow.json.thisWeek.points).toBe(perDay + 100);
  });

  it("caps game results per day", async () => {
    const now = freshWeek();
    const p = await joinPlayer("Gamer", now);
    const n = LIMITS.scores.perRequest.games;
    let accepted = 0;
    for (let i = 0; accepted < LIMITS.scores.perDay.games; i++) {
      const r = await score(p.token, { games: new Array(n).fill({ game: "snake", score: 3 }) }, now + i);
      accepted += r.json.accepted.games;
    }
    const over = await score(p.token, { games: [{ game: "snake", score: 99 }] }, now + 5000);
    expect(over.json.capped).toBe(true);
    expect(over.json.thisWeek.snake).toBe(3);
  });
});
