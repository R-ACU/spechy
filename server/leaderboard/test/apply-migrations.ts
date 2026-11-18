import { applyD1Migrations, env } from "cloudflare:test";

// Runs before every test file; applyD1Migrations only applies what is missing.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
