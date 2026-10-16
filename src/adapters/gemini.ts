// Gemini single-stage transcription (research.md; contracts/asr-provider.interface.ts).
//
// Audio goes up through the Files API as raw bytes rather than inline base64:
// base64-encoding a long voice note would burn the free plan's ~10 ms CPU
// budget, while passing an ArrayBuffer through fetch costs almost nothing.
import type { Deps } from './deps';
import { HttpError, fetchWithRetry, type RetryPolicy } from './http';

const API = 'https://generativelanguage.googleapis.com';

export class TranscriptionError extends Error {
  constructor(
    /** Stable machine code → jobs.error_code. */
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = true,
  ) {
    super(message);
  }
}

export interface GeminiConfig {
  apiKey: string;
  model: string;
  fallbackModel?: string;
  prompt: string;
  promptVersion: string;
}

export interface TranscriptionResult {
  raw: string;
  clean: string;
  /** e.g. "gemini-single:gemini-3.5-flash" → jobs.asr_provider. */
  provider: string;
  promptVersion: string;
  asrMs: number;
}

// A successful gemini-3.8-flash probe call once took 173 s (research.md §Findings).
const GENERATE_POLICY: RetryPolicy = { timeoutMs: 180_000, attempts: 3, baseDelayMs: 2_000 };
const FALLBACK_POLICY: RetryPolicy = { ...GENERATE_POLICY, attempts: 1 };
const FILES_POLICY: RetryPolicy = { timeoutMs: 60_000, attempts: 3, baseDelayMs: 1_000 };

interface GeminiFile {
  name: string; // "files/abc123"
  uri: string;
  mimeType: string;
  state?: 'STATE_UNSPECIFIED' | 'PROCESSING' | 'ACTIVE' | 'FAILED';
}

export function createGemini(config: GeminiConfig, deps: Pick<Deps, 'fetch' | 'sleep' | 'now' | 'log'>) {
  const auth = { 'x-goog-api-key': config.apiKey };

  async function upload(audio: ArrayBuffer, mimeType: string, displayName: string): Promise<GeminiFile> {
    const start = await fetchWithRetry(
      deps,
      `${API}/upload/v1beta/files`,
      {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': 'application/json',
          'x-goog-upload-protocol': 'resumable',
          'x-goog-upload-command': 'start',
          'x-goog-upload-header-content-length': String(audio.byteLength),
          'x-goog-upload-header-content-type': mimeType,
        },
        body: JSON.stringify({ file: { display_name: displayName } }),
      },
      FILES_POLICY,
    );
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new TranscriptionError('GEMINI_UPLOAD', 'Files API returned no upload URL');
    const done = await fetchWithRetry(
      deps,
      uploadUrl,
      {
        method: 'POST',
        headers: { 'x-goog-upload-offset': '0', 'x-goog-upload-command': 'upload, finalize' },
        body: audio,
      },
      FILES_POLICY,
    );
    const { file } = (await done.json()) as { file?: GeminiFile };
    if (!file?.uri) throw new TranscriptionError('GEMINI_UPLOAD', 'Files API returned no file');
    return file;
  }

  async function waitActive(file: GeminiFile): Promise<GeminiFile> {
    let current = file;
    for (let i = 0; current.state === 'PROCESSING' && i < 30; i++) {
      await deps.sleep(1_000);
      const res = await fetchWithRetry(deps, `${API}/v1beta/${file.name}`, { headers: auth }, FILES_POLICY);
      current = (await res.json()) as GeminiFile;
    }
    if (current.state === 'PROCESSING') throw new TranscriptionError('GEMINI_UPLOAD', 'file still processing after 30 s');
    if (current.state === 'FAILED') throw new TranscriptionError('GEMINI_UPLOAD', 'file processing failed', false);
    return current;
  }

  async function remove(file: GeminiFile): Promise<void> {
    try {
      await deps.fetch(`${API}/v1beta/${file.name}`, {
        method: 'DELETE',
        headers: auth,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      // Files expire on their own after 48 h; a failed delete only shortens nothing.
      deps.log('gemini_file_delete_failed', { file: file.name, error: String(e) });
    }
  }

  async function generate(model: string, file: GeminiFile, policy: RetryPolicy) {
    const res = await fetchWithRetry(
      deps,
      `${API}/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ fileData: { mimeType: file.mimeType, fileUri: file.uri } }, { text: config.prompt }] },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: { verbatim: { type: 'STRING' }, formatted: { type: 'STRING' } },
              required: ['verbatim', 'formatted'],
            },
          },
        }),
      },
      policy,
    );
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    let parsed: { verbatim?: unknown; formatted?: unknown };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TranscriptionError('GEMINI_BAD_OUTPUT', `unparseable output (finishReason=${candidate?.finishReason})`);
    }
    if (typeof parsed.verbatim !== 'string' || typeof parsed.formatted !== 'string') {
      throw new TranscriptionError('GEMINI_BAD_OUTPUT', 'output is missing verbatim/formatted strings');
    }
    return { raw: parsed.verbatim, clean: parsed.formatted };
  }

  return {
    /**
     * Retries the primary model per FR-028; if it is still overloaded
     * (429/5xx), tries the fallback model once (plan.md §2).
     */
    async transcribe(audio: ArrayBuffer, mimeType: string, correlationId: string): Promise<TranscriptionResult> {
      const t0 = deps.now();
      let file: GeminiFile | undefined;
      try {
        file = await waitActive(await upload(audio, mimeType, `voicescribe-${correlationId}`));
        let model = config.model;
        let out;
        try {
          out = await generate(model, file, GENERATE_POLICY);
        } catch (e) {
          const overloaded = e instanceof HttpError && e.retryable;
          if (!overloaded || !config.fallbackModel || config.fallbackModel === config.model) throw e;
          deps.log('gemini_fallback', { correlation_id: correlationId, from: model, to: config.fallbackModel, status: e.status });
          model = config.fallbackModel;
          out = await generate(model, file, FALLBACK_POLICY);
        }
        return { ...out, provider: `gemini-single:${model}`, promptVersion: config.promptVersion, asrMs: deps.now() - t0 };
      } catch (e) {
        if (e instanceof TranscriptionError) throw e;
        if (e instanceof HttpError) {
          throw new TranscriptionError(e.retryable ? 'GEMINI_UNAVAILABLE' : 'GEMINI_REJECTED', e.message, e.retryable);
        }
        throw new TranscriptionError('GEMINI_ERROR', e instanceof Error ? e.message : String(e));
      } finally {
        if (file) await remove(file);
      }
    },
  };
}

export type Gemini = ReturnType<typeof createGemini>;
