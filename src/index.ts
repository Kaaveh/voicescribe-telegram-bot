import { defaultDeps } from './adapters/deps';
import { handleBatch } from './consumer';
import type { Env, QueueJob } from './env';
import { createApp } from './producer';

const app = createApp(defaultDeps);

export default {
  fetch: app.fetch,
  queue: (batch, env) => handleBatch(batch, env, defaultDeps),
} satisfies ExportedHandler<Env, QueueJob>;
