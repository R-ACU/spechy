// All sanity limits in one place. Tune here, the tests read the same constants.

export const GAMES = ["tower", "snake", "comet"] as const;
export type Game = (typeof GAMES)[number];

export const LIMITS = {
  name: { min: 3, max: 20 },
  titleIdPattern: /^[a-z0-9][a-z0-9_-]{0,31}$/,
  maxJsonBytes: 8 * 1024,

  scores: {
    perRequest: { points: 5_000, words: 20_000, games: 20 },
    perDay: { points: 50_000, words: 60_000, games: 400 },
    /** Highest single result the server believes per game. */
    maxGameScore: { tower: 10_000, snake: 5_000, comet: 1_000_000 } as Record<Game, number>,
  },

  rank: { maxTier: 6, maxDivision: 2, maxRp: 100 },

  avatar: {
    maxBytes: 256 * 1024,
    minSide: 32,
    maxSide: 1024,
    cacheSeconds: 3600,
  },

  report: { maxNote: 200 },

  leaderboard: { top: 100 },

  /** Rate limits: [max requests, window seconds]. */
  rate: {
    ipAll: [600, 60],
    tokenAll: [240, 60],
    ipJoin: [5, 3600],
    tokenScores: [60, 3600],
    tokenAvatar: [10, 86400],
    tokenReport: [30, 86400],
    tokenProfile: [30, 3600],
  } satisfies Record<string, [number, number]>,

  /** Week history kept by the daily cron. */
  historyWeeks: 52,
} as const;
