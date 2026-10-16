# VoiceScribe

A personal Telegram bot that turns Persian voice messages into clean, readable
transcripts. Forward it a voice note and, a few seconds later, its "⏳" reply
becomes punctuated, paragraphed Persian text with correct `ی`/`ک` and
half-spaces (ZWNJ). English terms stay in Latin script. Nothing is added or
summarized.

Each person runs their own copy, which answers only its owner. It runs on
Cloudflare Workers' free plan and Gemini's free tier: **$0/month, no payment
method needed**.

```
Telegram → Worker (webhook) → Queue → Worker (consumer) → Gemini → edits the reply
                                       stores audio + transcripts in KV for 30 days, job state in D1
```

## What you need

| Item | Where | Notes |
|---|---|---|
| Node.js 22+ | [nodejs.org](https://nodejs.org) | |
| Telegram bot token | [@BotFather](https://t.me/BotFather) | free |
| Gemini API key | [Google AI Studio](https://aistudio.google.com/apikey) | free tier; check it's available in your region |
| Cloudflare account | [dash.cloudflare.com](https://dash.cloudflare.com) | free plan |

## Setup

**1. Install.**

```sh
git clone https://github.com/Kaaveh/voicescribe-telegram-bot.git
cd voicescribe-telegram-bot
npm install
```

**2. Create the bot.** In @BotFather, send `/newbot` and keep the token. Then
send `/setprivacy`, pick your bot and choose **Enable**. Never add the bot to a
group.

**3. Find your numeric Telegram user ID.** Send your new bot any message, then:

```sh
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

Your ID is `message.from.id`. The bot authorizes by this number, never by
username. If you get an empty result, send the bot another message and retry.
If you get a 409 conflict, a webhook is already set: call `.../deleteWebhook`
first.

**4. Log in to Cloudflare.**

```sh
npx wrangler login
npx wrangler whoami     # copy the Account ID you'll deploy to
```

If you've never used Workers, open **Workers & Pages** in the dashboard once
so your `*.workers.dev` subdomain exists.

**5. Write `secrets.env`** at the repo root. It's gitignored, so it never
leaves your machine:

```sh
CLOUDFLARE_ACCOUNT_ID=<from step 4>
TELEGRAM_BOT_TOKEN=<from step 2>
OWNER_TELEGRAM_USER_ID=<from step 3>
GEMINI_API_KEY=<from AI Studio>
```

Write one `KEY=value` per line, with no spaces around `=`. The script sources
this file in the shell, so stray spaces break it. On a machine without a
browser login, also set `CLOUDFLARE_API_TOKEN`: start from the "Edit Cloudflare
Workers" template and add D1:Edit, Queues:Edit and Workers KV Storage:Edit.

**6. Provision and deploy.**

```sh
./scripts/provision.sh
```

The script is idempotent: re-running it is safe and doesn't duplicate
anything. It does the following:

1. Creates the queues, the KV namespace and the D1 database, and applies the
   database migrations.
2. Deploys the Worker and uploads the secrets.
3. Generates fresh webhook secrets and registers the Telegram webhook.
4. Writes your D1 and KV IDs into `wrangler.jsonc`. Commit that change in your
   copy.

**7. Use it.** Send the bot `/start`, then forward it a voice message.

## Using the bot

| You send | It does |
|---|---|
| a voice message (forwarded or recorded) | replies "⏳", then edits that reply into the transcript |
| a very long voice message | sends the transcript as a `.md` file (over 4,000 characters) |
| `/retry` as a reply to an error message | runs that failed job again |
| `/start` or `/help` | shows usage |

Voice files over Telegram's 20 MB bot limit get a clear error. The bot ignores
everyone except `OWNER_TELEGRAM_USER_ID`.

## Configuration

Secrets live only in Cloudflare (`provision.sh` sets them), and settings live
in `wrangler.jsonc` → `vars`:

| Var | Default | Meaning |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.5-flash` | exact model ID, never an alias like `gemini-flash-latest` |
| `GEMINI_FALLBACK_MODEL` | `gemini-3.5-flash-lite` | used when the main model is overloaded (503/429) |
| `LENGTH_GUARD_MIN` / `MAX` | `0.6` / `1.4` | clean÷raw length bounds; outside them, the raw text is sent with a marker |
| `NUMERAL_STYLE` | `persian` | digits in the output |

After changing `vars` or code, run `npx wrangler deploy`. Re-run
`provision.sh` only to change secrets: it also rotates the webhook secrets.

## Operating

```sh
npx wrangler tail                       # live logs (metadata only; transcripts are never logged)
npx wrangler d1 execute voicescribe --remote \
  --command "SELECT id, error_code, created_at FROM jobs WHERE status = 'failed'"
```

- **Free-plan ceilings:** KV allows 1,000 writes a day, which is about 500 voice
  notes. Gemini's free tier has its own rate limits, and the bot backs off and
  falls back automatically.
- **Leaked bot token:** in BotFather send `/revoke`, update `secrets.env`, and
  re-run `provision.sh`.

## Privacy

- Forwarded voice notes are other people's speech. On Gemini's **free tier**,
  Google may use submitted audio and text to improve its products, including
  through human review. Use a paid key if that's not acceptable.
- Stored audio and transcripts expire after 30 days. Logs hold only IDs,
  timings and lengths.

## Development

```sh
npm run check    # typecheck + all tests, inside the Workers runtime; no accounts needed
npm run dev      # local Worker; put the same secrets in .dev.vars (gitignored)
```

| Path | Contents |
|---|---|
| `src/core/` | pure logic: authorization, guards, formatting, user-facing copy |
| `src/adapters/` | Telegram, Gemini, D1, KV |
| `src/producer.ts`, `src/consumer.ts` | webhook handler, queue consumer |
| `prompts/` | versioned Gemini prompts |
| `specs/001-voice-transcription/` | spec, plan, data model, contracts, tasks |

The project follows [Spec Kit](https://github.com/github/spec-kit). The
[constitution](.specify/memory/constitution.md) and the
[spec](specs/001-voice-transcription/spec.md) are authoritative, and every
`FR-0xx` requirement maps to a test.

## For AI agents

- Follow **Setup** in order. Steps 2, 3 and Gemini key creation need the human;
  step 4's `wrangler login` opens their browser.
- Never print, log or commit values from `secrets.env` or `.dev.vars`. To check
  that a value is set, test it without echoing it.
- Confirm `npx wrangler whoami` shows the intended account before running
  `provision.sh`.
- Run `npm run check` before every commit.
- Prompts in `prompts/` are versioned source (constitution, Article V).
  Change one by adding a new version (for example `transcribe-fa.v2.md`), and
  have the owner check real transcripts before shipping it.

## License

[MIT](LICENSE) · Security issues: see [SECURITY.md](SECURITY.md).
