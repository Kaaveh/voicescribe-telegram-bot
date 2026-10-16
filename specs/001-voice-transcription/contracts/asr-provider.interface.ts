/**
 * Contract: transcription pipeline (Constitution art. IV — adapters behind
 * interfaces; swapping providers is a one-file change plus config).
 *
 * Both pipeline shapes (Gemini single-stage, Scribe→LLM two-stage, Workers AI
 * fallback) implement TranscriptionPipeline so persistence (FR-023), guards
 * (FR-026/027), and delivery are pipeline-agnostic. The single-stage
 * implementation returns structured `{verbatim, formatted}` from one call so
 * `raw` remains a real baseline for the length guard.
 */

export interface AudioInput {
  /** Audio bytes read from KV — never buffered into a queue message. */
  body: ReadableStream<Uint8Array> | ArrayBuffer;
  mimeType: string; // e.g. "audio/ogg"
  durationSec: number;
  /** Pinned to "fa" in v1 (FR-022). */
  languageCode: 'fa';
}

export interface PipelineResult {
  /** Verbatim ASR text — persisted as `raw` in KV transcripts/{job} (FR-023). */
  raw: string;
  /** Normalized text — validated by guards before delivery (FR-025..027). */
  clean: string;
  provider: 'gemini-single' | 'scribe-llm' | 'workers-ai';
  /** Latencies for FR-040 logging. Single-stage sets llmMs = 0. */
  asrMs: number;
  llmMs: number;
  /** Versioned prompt file(s) used (Constitution art. V), e.g. "transcribe-fa.v1". */
  promptVersion: string;
}

export interface TranscriptionPipeline {
  readonly name: PipelineResult['provider'];
  /**
   * MUST apply explicit timeouts and retry 5xx/429 with exponential backoff,
   * max 3 attempts (FR-028). MUST throw TranscriptionError on terminal
   * failure — the consumer maps it to the FR-034 user message + DLQ path.
   */
  transcribe(audio: AudioInput, correlationId: string): Promise<PipelineResult>;
}

export class TranscriptionError extends Error {
  constructor(
    /** Stable machine code → jobs.error_code, e.g. "ASR_TIMEOUT", "ASR_5XX". */
    public readonly code: string,
    message: string,
    /** True if the queue should retry the job (default: yes). */
    public readonly retryable: boolean = true,
  ) {
    super(message);
  }
}

/** Pure validation verdict (src/core/validate.ts — no I/O, Constitution art. IV). */
export interface ValidationResult {
  ok: boolean;
  /** e.g. "LENGTH_GUARD" (FR-026), "SCRIPT_GUARD" (FR-027), "NGRAM_LOOP". */
  failures: string[];
  /** clean.length / raw.length — logged for FR-026 tuning. */
  lengthRatio: number;
}
