// Side-effecting capabilities, injected so tests can replace them.

export interface Deps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  uuid: () => string;
  /** Structured log line. Never pass transcript content (FR-041). */
  log: (event: string, fields?: Record<string, unknown>) => void;
}

export const defaultDeps: Deps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  uuid: () => crypto.randomUUID(),
  log: (event, fields = {}) => console.log(JSON.stringify({ event, ...fields })),
};
