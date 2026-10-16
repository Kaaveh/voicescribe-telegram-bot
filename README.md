# VoiceScribe

A single-tenant Telegram bot that turns Persian voice messages into clean,
readable transcripts. Forward a voice note to the bot, and a few seconds later
the placeholder reply is replaced with a punctuated, paragraphed,
orthographically correct Persian transcript. It runs on Cloudflare Workers
with a $0/month baseline.

> **Status: deployed and transcribing.** Covered by 45 tests that run in the
> Workers runtime. Live quality sign-off is in progress (see [Roadmap](#roadmap)).

## Why

Telegram's built-in transcription and raw ASR output return a wall of
unpunctuated tokens. The bar here is a *readable Persian document*:

- Persian punctuation (`،` `؛` `؟`), never the ASCII equivalents
- Persian `ی`/`ک`, never Arabic `ي`/`ك`, and correct ZWNJ (`می‌روم`, not `میروم`)
- paragraphs at topic boundaries, with filler words removed only when they carry no meaning
- English technical terms kept in Latin script (`Kubernetes`, not `کوبرنتیز`)
- **nothing added, summarized, or answered**, enforced by automated length and script guards

Getting there takes a strong ASR model plus an LLM normalization pass, so the
riskiest part of the system is the prompt. That's why prompts are versioned
source files under [`prompts/`](prompts/).

## Architecture

```
Telegram ──POST /webhook/<secret-path>──▶ Producer Worker (Hono)
                                           • verify secret-token header
                                           • authorize owner by numeric user ID
                                           • dedup on update_id (D1)
                                           • reply "⏳ …" placeholder
                                           • enqueue job
                                                 │ Cloudflare Queue
                                                 ▼
                                         Consumer Worker
                                           • download audio → KV
                                           • ASR (+ LLM normalization)
                                           • validate (length / script / loop guards)
                                           • edit placeholder with transcript
                                           • retries → DLQ, user always notified
```

Workers, Queues, KV and D1 all run on Cloudflare's free plan, with no payment
method on file. The default
pipeline is Gemini on the Google AI Studio free tier. Full design:
[PRD](PRD-voicescribe-telegram-bot.md) ·
[spec](specs/001-voice-transcription/spec.md) ·
[plan](specs/001-voice-transcription/plan.md) ·
[data model](specs/001-voice-transcription/data-model.md).

## Spec-driven, agent-operated

The project follows [GitHub Spec Kit](https://github.com/github/spec-kit)
conventions. A [constitution](.specify/memory/constitution.md) sets
non-negotiable principles (single-tenant by construction, the transcript is
sacred, never fail silently, no secrets in source). Every functional
requirement has a stable ID (`FR-0xx`) that maps to a test, and an AI coding
agent provisions all Cloudflare infrastructure through recorded `wrangler`
commands, with no dashboard click-ops.

## Repository layout

```
.specify/memory/constitution.md   project principles
PRD-voicescribe-telegram-bot.md   product requirements (narrative authority)
specs/001-voice-transcription/    spec, plan, research, data model, contracts, tasks
prompts/                          versioned LLM prompts (transcribe / normalize)
src/core/                         pure logic: authorization, guards, formatting, copy
src/adapters/                     Telegram, Gemini, D1, KV (I/O behind interfaces)
src/producer.ts, src/consumer.ts  webhook handler and queue consumer
migrations/                       D1 schema
tests/                            unit + integration tests (Vitest, Workers runtime)
scripts/                          provisioning and webhook registration
```

## Development

Requires Node.js 22+.

```sh
npm install
npm run check      # typecheck + all tests, fully local (no Cloudflare account needed)
```

Tests run inside the Workers runtime against real local D1 and KV, with
Telegram and Gemini replaced by fakes.

## Setup

VoiceScribe is single-tenant by design: there is no shared public bot. Each
person runs their own instance on their own accounts, and it answers only them.

### Accounts and credentials

| Service | Needed for | What you get from it | Cost |
|---|---|---|---|
| [Google AI Studio](https://aistudio.google.com/apikey) | Transcription (Gemini) | `GEMINI_API_KEY` | Free tier |
| [Cloudflare](https://dash.cloudflare.com/) | Hosting | Account ID, plus an API token or `wrangler login` | Free plan |
| Telegram [@BotFather](https://t.me/BotFather) | The bot itself | `TELEGRAM_BOT_TOKEN` | Free |

Notes:
- **Gemini API keys come only from AI Studio.** A Google AI Pro / Gemini
  Advanced subscription doesn't include API access. Also check that the AI
  Studio free tier is available in your region.
- **Cloudflare account ID:** you'll find it in the dashboard sidebar, or run
  `npx wrangler whoami`.
- **Cloudflare API token:** the permissions it needs are listed in
  [`plan.md` §5](specs/001-voice-transcription/plan.md).

### Where credentials live

Every credential lives in exactly two places, and never in git or chat:

- **The deployed bot:** Cloudflare Secrets, set with `wrangler secret put`.
  The Worker reads them at runtime.
- **Wherever `wrangler` runs:**
  - *On your machine:* environment variables in your shell.
  - *In a Claude Code cloud session:* the environment's settings (cloud
    environment menu → Edit), as network secrets or environment variables.
    Also add `api.cloudflare.com` and `api.telegram.org` to the
    environment's allowed domains. The agent then pipes each value into
    `wrangler secret put` without printing it.

GitHub repository secrets aren't used. Only GitHub Actions workflows can read
them; neither a Claude Code session nor the Worker can.

### Deploy your own bot

1. **Create the bot.** In @BotFather run `/newbot` and save the token. Then run
   `/setprivacy` → *Enable*. Never add the bot to a group.
2. **Find your numeric Telegram user ID.** Send your new bot any message, then
   open `https://api.telegram.org/bot<TOKEN>/getUpdates` and read
   `message.from.id`. This only works before a webhook is set. The bot
   authorizes by this ID, never by username.
3. **Provide credentials.** Export `CLOUDFLARE_ACCOUNT_ID`, `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_USER_ID` and
   `GEMINI_API_KEY`, or put them in a `secrets.env` file at the repo root
   (gitignored; `provision.sh` loads it). Either run `npx wrangler login` once, or
   also set `CLOUDFLARE_API_TOKEN`: start from the "Edit Cloudflare Workers" template and add D1:Edit, Queues:Edit and Workers KV Storage:Edit.
4. **Provision and deploy:**

   ```sh
   npm install
   ./scripts/provision.sh
   ```

   The script is idempotent. It creates the queues, the KV namespace and the
   D1 database with its migrations. It then
   deploys, stores the secrets, generates fresh webhook secrets, and registers
   the webhook. It writes the D1 `database_id` and the KV namespace `id` into
   `wrangler.jsonc`; commit that change.

Once deployed, send the bot `/start`, then forward it a voice message. If a
transcription fails, the error message includes a tracking code: reply to it
with `/retry` to try again.

Configuration (`provision.sh` stores the secrets; never commit them):

| Name | Kind | Value |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | secret | from BotFather |
| `OWNER_TELEGRAM_USER_ID` | secret | your numeric ID from step 2 |
| `GEMINI_API_KEY` | secret | from AI Studio |
| `WEBHOOK_SECRET_TOKEN` | secret | random, high entropy (e.g. `openssl rand -hex 32`) |
| `WEBHOOK_PATH_SEGMENT` | secret | random, high entropy, different from the above |
| `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL` | var | exact model IDs, default `gemini-3.5-flash` / `gemini-3.5-flash-lite`; don't use an alias like `gemini-flash-latest` |
| `LENGTH_GUARD_MIN` / `LENGTH_GUARD_MAX` | var | `0.6` / `1.4`; tune them if real transcripts trip the guard |
| `NUMERAL_STYLE` | var | `persian` |

For local development, put the same secrets in `.dev.vars`. It's gitignored.

## Privacy

A transcription bot handles other people's speech: forwarded voice messages
come from your contacts. If you deploy your own instance:

- On Google AI Studio's **free tier**, Google may use submitted audio and text
  to improve its products, including through human review. Use the paid tier
  if that's not acceptable.
- The design keeps transcript content out of logs, and a 30-day TTL on every
  stored key deletes stored audio and transcripts after 30 days.
- The bot answers only its owner's numeric Telegram user ID and stays silent
  to everyone else.

## Roadmap

Progress is tracked in [`tasks.md`](specs/001-voice-transcription/tasks.md):

- [x] Phase 0: constitution and spec
- [x] Phase 1: provider setup (model confirmed with live calls)
- [x] Phase 2: plan, contracts and data model (one docs check open: Queues free-plan time limit)
- [x] Phase 3: deployed to Cloudflare
- [ ] Phase 4: full transcription pipeline (live; owner quality sign-off on 10 transcripts pending)
- [ ] Phase 5: resilience — retries, DLQ, idempotency, `/retry` (code and tests done; live checks pending)
- [ ] Phase 6: golden-transcript regression suite and observability

## Security

See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
