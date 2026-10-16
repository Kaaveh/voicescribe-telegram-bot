# VoiceScribe Constitution

**Version:** 1.0.2 · **Ratified:** 2026-08-07 · **Amended:** 2026-10-16 · **Owner:** Kaaveh

Non-negotiable principles governing how specs become code in this repository.
Every plan, task, and PR must pass the compliance check in §Governance.

---

## Article I — Single-tenant by construction

Owner-ID authorization (`message.from.id === OWNER_TELEGRAM_USER_ID`) is checked
at the outermost boundary, before any other logic. No code path may reach an ASR
or LLM call without passing it. Authorization is by numeric user ID only — never
username. Unauthorized traffic gets silence, never an error message.

*Rationale: the entire security model of a single-user bot collapses if auth is
checked late or leaks information to probers.*

## Article II — The transcript is sacred

No component may add, remove, reorder, summarize, translate, or "answer" spoken
content. Only formatting-level transformations are permitted (punctuation,
paragraphing, orthography, disfluency removal), and they are enforced by
automated guards (length guard, script guard) that run before every delivery.

*Rationale: silent summarization is the worst failure mode — the output still
looks good while data is lost.*

## Article III — Never fail silently

Every error path terminates in a user-visible Persian message containing a
Latin/ASCII correlation ID. A dropped update, a swallowed exception, or an empty
DLQ entry with no user notification is a defect, not an incident.

## Article IV — Pure core, thin edges

Normalization, validation, and formatting are pure functions in `src/core/`
with no I/O — unit-testable without network or Cloudflare bindings. Telegram,
ASR/LLM providers, and storage live behind interfaces in `src/adapters/`.
Swapping an ASR provider must be a one-file change plus config.

## Article V — Prompts are source code

Every LLM prompt is a versioned file under `prompts/`, code-reviewed like any
other source. A prompt change without a passing golden-transcript regression
suite is a breaking change and must not ship.

## Article VI — No secrets in source

Secrets live in Cloudflare Secrets (`wrangler secret put`) only. No token,
key, or webhook path segment may appear in source, config committed to git,
logs, or spec documents.

## Article VII — Every FR maps to a test

A functional requirement with no corresponding automated test (or, where noted,
documented manual verification) is not implemented. `specs/*/tasks.md` carries
the FR→test traceability.

## Article VIII — Agent-operated infrastructure

All Cloudflare resources (Workers, Queues, KV, D1, secrets, deployments) are
created and changed exclusively through `wrangler` commands executed by the AI
agent, with each command recorded in `specs/*/plan.md` or `scripts/`. No
dashboard click-ops: if it cannot be reproduced from the repository, it does
not exist. The target account is the deployer's own Cloudflare account; the
agent verifies with `wrangler whoami` that it is operating on that account
before any mutating command. Owner-side exceptions are explicit and finite: BotFather
bot creation & privacy mode, Google AI Studio / ElevenLabs key creation, and
granting the agent Cloudflare credentials (`wrangler login` locally or a scoped
`CLOUDFLARE_API_TOKEN` for remote sessions).

---

## Governance

- This constitution supersedes ad-hoc practice. Deviations must be justified in
  the relevant `plan.md` and approved by the owner.
- Amendments: PR + owner approval + semantic version bump
  (breaking article change = major).
- Every phase gate in `specs/001-voice-transcription/tasks.md` re-checks
  Articles I–VIII before proceeding.
