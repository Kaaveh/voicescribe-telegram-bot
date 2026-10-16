# Security Policy

## Reporting a vulnerability

Please don't open a public issue for security problems. Report them privately
through GitHub's **[Report a vulnerability](https://github.com/Kaaveh/voicescribe-telegram-bot/security/advisories/new)**
form on this repository. Expect an acknowledgement within a week.

## Scope

In scope: anything that would let someone other than the configured owner
trigger transcription, read transcripts, spend the owner's API quota, or
extract secrets. Examples are bypassing the webhook secret-token check or the
owner-ID authorization, or transcript content leaking into logs.

## Deploying your own instance

- Keep every credential in `wrangler secret` (Cloudflare Secrets), never in
  `wrangler.jsonc`, `.dev.vars` committed to git, or logs.
- If your bot token leaks, revoke it in BotFather (`/revoke`), then rotate
  `WEBHOOK_SECRET_TOKEN` and `WEBHOOK_PATH_SEGMENT` and re-run webhook
  registration.
- Leave the bot's privacy mode enabled, and don't add the bot to groups.
