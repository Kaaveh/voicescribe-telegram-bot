import type { D1Migration } from 'cloudflare:test';

export interface QueueJob {
  jobId: string;
}

export interface Env {
  DB: D1Database;
  AUDIO: KVNamespace;
  JOBS: Queue<QueueJob>;

  // Secrets (`wrangler secret put`).
  TELEGRAM_BOT_TOKEN: string;
  OWNER_TELEGRAM_USER_ID: string;
  GEMINI_API_KEY: string;
  WEBHOOK_SECRET_TOKEN: string;
  WEBHOOK_PATH_SEGMENT: string;

  // Vars (wrangler.jsonc).
  GEMINI_MODEL: string;
  GEMINI_FALLBACK_MODEL: string;
  LENGTH_GUARD_MIN: string;
  LENGTH_GUARD_MAX: string;
  NUMERAL_STYLE: string;
}

type AppEnv = Env;

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
