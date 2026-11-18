import { GAMES, LIMITS, type Game } from "../limits";
import { containsProfanity, isReserved } from "../profanity";
import { badRequest } from "./http";

/** Trims, normalizes and checks a display name. Throws a validation error with a reason. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") throw badRequest("name must be a string", { field: "name" });
  const name = raw.normalize("NFC").replace(/\s+/gu, " ").trim();
  const length = [...name].length;
  if (length < LIMITS.name.min || length > LIMITS.name.max) {
    throw badRequest(`name must be ${LIMITS.name.min} to ${LIMITS.name.max} characters`, { field: "name", reason: "length" });
  }
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.\-]*$/u.test(name)) {
    throw badRequest("name may only contain letters, digits, spaces and _ . -", { field: "name", reason: "characters" });
  }
  if (containsProfanity(name)) throw badRequest("name is not allowed", { field: "name", reason: "profanity" });
  if (isReserved(name)) throw badRequest("name is reserved", { field: "name", reason: "reserved" });
  return name;
}

export function cleanTitleId(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string" || !LIMITS.titleIdPattern.test(raw)) {
    throw badRequest("titleId must be null or a lowercase id like night-owl", { field: "titleId" });
  }
  return raw;
}

export function intInRange(raw: unknown, field: string, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw badRequest(`${field} must be an integer from ${min} to ${max}`, { field });
  }
  return raw;
}

export function isGame(value: unknown): value is Game {
  return typeof value === "string" && (GAMES as readonly string[]).includes(value);
}
