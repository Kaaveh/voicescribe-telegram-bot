import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Test-only values; real ones come from `wrangler secret put`.
          bindings: {
            TEST_MIGRATIONS: migrations,
            TELEGRAM_BOT_TOKEN: '123456:test-token',
            OWNER_TELEGRAM_USER_ID: '1001',
            GEMINI_API_KEY: 'test-gemini-key',
            WEBHOOK_SECRET_TOKEN: 'test-secret-token',
            WEBHOOK_PATH_SEGMENT: 'test-path-segment',
          },
        },
      }),
    ],
    test: { setupFiles: ['./tests/setup.ts'] },
  };
});
