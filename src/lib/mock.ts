// TESTCODE: dev-only helper. Outside Tauri every invoke() rejects, so views fall back
// to the mock payload placed on window.__SPECHY_MOCK__ by src/dev-d.tsx.
// In the real app the try/catch never fires and the backend data is used.

declare global {
  interface Window {
    __SPECHY_MOCK__?: Record<string, unknown>;
  }
}

/** Await a backend call; on failure use window.__SPECHY_MOCK__[key], else the given fallback. */
export async function safeCall<T>(call: () => Promise<T>, key: string, fallback: T): Promise<T> {
  try {
    return await call();
  } catch {
    const m = import.meta.env.DEV && typeof window !== "undefined" ? window.__SPECHY_MOCK__ : undefined;
    if (m && key in m) return m[key] as T;
    return fallback;
  }
}

/** Fire and forget a backend call that has no meaningful return value. */
export async function safeVoid(call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
    return true;
  } catch {
    return false;
  }
}

export {};
