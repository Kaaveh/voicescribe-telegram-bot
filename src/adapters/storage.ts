// KV layout (data-model.md): audio shared across jobs, transcripts per job.
// Every key expires 30 days after it is written (FR-050).
// ponytail: KV is eventually consistent across locations; a miss only costs a
// re-download or a repeat ASR call, never a wrong transcript.

const TTL_SECONDS = 30 * 24 * 60 * 60;

export const audioKey = (fileUniqueId: string) => `audio/${fileUniqueId}.ogg`;
const transcriptsKey = (jobId: string) => `transcripts/${jobId}`;

export interface Transcripts {
  raw: string;
  clean: string;
}

export function createStorage(kv: KVNamespace) {
  return {
    async hasAudio(key: string): Promise<boolean> {
      const body = await kv.get(key, 'stream');
      await body?.cancel();
      return body !== null;
    },

    async putAudio(key: string, bytes: ArrayBuffer, mimeType: string): Promise<void> {
      await kv.put(key, bytes, { expirationTtl: TTL_SECONDS, metadata: { mimeType } });
    },

    async getAudio(key: string): Promise<{ bytes: ArrayBuffer; mimeType: string } | null> {
      const { value, metadata } = await kv.getWithMetadata<{ mimeType?: string }>(key, 'arrayBuffer');
      if (!value) return null;
      return { bytes: value, mimeType: metadata?.mimeType ?? 'audio/ogg' };
    },

    /** One value holds both texts, so they are persisted together or not at all (FR-023/029). */
    async putTranscripts(jobId: string, t: Transcripts): Promise<void> {
      await kv.put(transcriptsKey(jobId), JSON.stringify(t), { expirationTtl: TTL_SECONDS });
    },

    async getTranscripts(jobId: string): Promise<Transcripts | null> {
      return kv.get<Transcripts>(transcriptsKey(jobId), 'json');
    },
  };
}

export type Storage = ReturnType<typeof createStorage>;
