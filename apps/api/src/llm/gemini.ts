import { AppError } from '../lib/errors.js';
import { postForStream, type FetchFn } from './http.js';
import type { LlmProvider, LlmRequest } from './provider.js';
import { readSse } from './sse.js';

export interface GeminiConfig {
  apiKey: string;
  model: string;
  maxInputChars?: number;
  baseUrl?: string;
  fetchImpl?: FetchFn;
}

interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; status?: string; message?: string };
}

const REFUSAL_REASONS = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_SAFETY',
]);

export function createGeminiProvider(cfg: GeminiConfig): LlmProvider {
  const baseUrl = cfg.baseUrl ?? 'https://generativelanguage.googleapis.com';
  const fetchFn: FetchFn = cfg.fetchImpl ?? ((i, init) => fetch(i, init));

  return {
    name: 'gemini',
    model: cfg.model,
    maxInputChars: cfg.maxInputChars ?? 150_000,
    async *stream(req: LlmRequest) {
      // The key travels in a header, never in the URL, so it cannot leak through logs or referrers.
      const res = await postForStream(
        fetchFn,
        `${baseUrl}/v1beta/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`,
        { 'x-goog-api-key': cfg.apiKey },
        {
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.user }] }],
          generationConfig: {
            temperature: req.temperature,
            maxOutputTokens: req.maxOutputTokens,
            ...(req.json ? { responseMimeType: 'application/json' } : {}),
          },
        },
        req.signal,
      );

      for await (const data of readSse(res.body)) {
        let chunk: GeminiChunk;
        try {
          chunk = JSON.parse(data) as GeminiChunk;
        } catch {
          continue; // ignore malformed keep-alives
        }
        if (chunk.error) {
          throw new AppError(chunk.error.code === 429 ? 'ai_quota_exhausted' : 'ai_unavailable', {
            detail: `stream-error ${chunk.error.status ?? ''}`,
          });
        }
        if (chunk.promptFeedback?.blockReason) {
          throw new AppError('ai_refused', {
            detail: `prompt-blocked:${chunk.promptFeedback.blockReason}`,
          });
        }
        const cand = chunk.candidates?.[0];
        const text = (cand?.content?.parts ?? [])
          .filter((p) => !p.thought)
          .map((p) => p.text ?? '')
          .join('');
        if (text) yield text;
        const finish = cand?.finishReason;
        if (finish && REFUSAL_REASONS.has(finish))
          throw new AppError('ai_refused', { detail: `finish:${finish}` });
      }
    },
  };
}
