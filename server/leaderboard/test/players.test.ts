import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/lib/crypto";
import { containsProfanity } from "../src/profanity";
import { call, joinPlayer } from "./helpers";

describe("join", () => {
  it("creates an anonymous player and stores only the token hash", async () => {
    const r = await call("POST", "/v1/join", { body: { name: "  Remo   Test ", titleId: "night-owl", tier: 2, division: 1, rp: 40 } });
    expect(r.status).toBe(201);
    expect(r.json.token).toMatch(/^spk_[A-Za-z0-9_-]{43}$/);
    expect(r.json.player).toMatchObject({ name: "Remo Test", titleId: "night-owl", rank: { tier: 2, division: 1, rp: 40 }, avatar: null });
    expect(r.json.player.id).toMatch(/^p_[0-9a-f]{16}$/);
    expect(r.json.thisWeek).toMatchObject({ points: 0, words: 0, rank: null });

    const row = await env.DB.prepare("SELECT * FROM players WHERE id = ?1").bind(r.json.player.id).first<Record<string, unknown>>();
    expect(row!.token_hash).toBe(await sha256Hex(r.json.token));
    expect(JSON.stringify(row)).not.toContain(r.json.token);
    // no column for e-mail, password or any text content
    expect(Object.keys(row!).sort()).not.toContain("email");
  });

  it("gives a default name when none is sent", async () => {
    const r = await call("POST", "/v1/join", { body: {} });
    expect(r.status).toBe(201);
    expect(r.json.player.name).toMatch(/^Speaker \d{4}$/);
  });

  it.each([
    ["ab", "length"],
    ["x".repeat(21), "length"],
    ["<script>", "characters"],
    ["Sh1t happens", "profanity"],
    ["F.U.C.K", "profanity"],
    ["Hurensohn", "profanity"],
    ["Admin", "reserved"],
  ])("rejects the name %j (%s)", async (name, reason) => {
    const r = await call("POST", "/v1/join", { body: { name } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("validation_failed");
    expect(r.json.error.details.reason).toBe(reason);
  });

  it("does not flag ordinary names (Scunthorpe check)", () => {
    for (const n of ["Cassandra", "Hancock", "Dickens", "Titan", "Fukuda", "Arthur E", "Spasskaya"]) {
      expect(containsProfanity(n), n).toBe(false);
    }
  });

  it("rejects non-JSON bodies with consistent error JSON", async () => {
    const r = await call("POST", "/v1/join", { raw: "name=x", headers: { "Content-Type": "text/plain" } });
    expect(r.status).toBe(415);
    expect(r.json).toEqual({ error: { code: "unsupported_media_type", message: expect.any(String) } });
    const bad = await call("POST", "/v1/join", { raw: "{nope", headers: { "Content-Type": "application/json" } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("invalid_json");
  });

  it("limits joins per IP", async () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < 5; i++) expect((await call("POST", "/v1/join", { body: {}, ip })).status).toBe(201);
    const r = await call("POST", "/v1/join", { body: {}, ip });
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe("rate_limited");
    expect(Number(r.res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("me", () => {
  it("requires a valid bearer token", async () => {
    const none = await call("GET", "/v1/me");
    expect(none.status).toBe(401);
    expect(none.json.error.code).toBe("unauthorized");
    const wrong = await call("GET", "/v1/me", { token: "spk_" + "a".repeat(43) });
    expect(wrong.status).toBe(401);
  });

  it("updates name, title and rank, and rejects bad values", async () => {
    const p = await joinPlayer("Updater");
    const ok = await call("PUT", "/v1/me", { token: p.token, body: { name: "Updated", titleId: "champion", tier: 6, division: 0, rp: 100 } });
    expect(ok.status).toBe(200);
    expect(ok.json.player).toMatchObject({ name: "Updated", titleId: "champion", rank: { tier: 6, division: 0, rp: 100 } });

    const clear = await call("PUT", "/v1/me", { token: p.token, body: { titleId: null } });
    expect(clear.json.player.titleId).toBeNull();
    expect(clear.json.player.name).toBe("Updated");

    expect((await call("PUT", "/v1/me", { token: p.token, body: { tier: 7 } })).status).toBe(400);
    expect((await call("PUT", "/v1/me", { token: p.token, body: { rp: 1.5 } })).status).toBe(400);
    expect((await call("PUT", "/v1/me", { token: p.token, body: { titleId: "Not Valid!" } })).status).toBe(400);
    const extra = await call("PUT", "/v1/me", { token: p.token, body: { coins: 999999 } });
    expect(extra.status).toBe(400);
    expect(extra.json.error.details.fields).toEqual(["coins"]);
  });

  it("answers 405 and 404 in the same error shape", async () => {
    const r = await call("PATCH", "/v1/me");
    expect(r.status).toBe(405);
    expect(r.res.headers.get("Allow")).toBe("GET, PUT, DELETE");
    const nf = await call("GET", "/v1/nope");
    expect(nf.status).toBe(404);
    expect(nf.json.error.code).toBe("not_found");
  });
});

describe("worker entry", () => {
  it("serves the health check through the real fetch handler", async () => {
    const res = await SELF.fetch("https://lb.test/v1/health");
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ok).toBe(true);
  });
});

describe("CORS", () => {
  it("answers preflight only for the app origins", async () => {
    const ok = await call("OPTIONS", "/v1/leaderboard", { headers: { Origin: "http://tauri.localhost", "Access-Control-Request-Method": "GET" } });
    expect(ok.status).toBe(204);
    expect(ok.res.headers.get("Access-Control-Allow-Origin")).toBe("http://tauri.localhost");
    expect(ok.res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");

    const evil = await call("OPTIONS", "/v1/leaderboard", { headers: { Origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    expect(evil.res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("refuses requests from foreign browser origins and tags allowed ones", async () => {
    const evil = await call("POST", "/v1/join", { body: {}, headers: { Origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    expect(evil.json.error.code).toBe("origin_not_allowed");

    const app = await call("POST", "/v1/join", { body: {}, headers: { Origin: "tauri://localhost" } });
    expect(app.status).toBe(201);
    expect(app.res.headers.get("Access-Control-Allow-Origin")).toBe("tauri://localhost");

    const native = await call("GET", "/v1/health");
    expect(native.res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
