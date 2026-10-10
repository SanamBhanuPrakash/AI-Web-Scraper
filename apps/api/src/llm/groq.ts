import { AppError } from '../lib/errors.js';
import { postForStream, type FetchFn } from './http.js';
import type { LlmProvider, LlmRequest } from './provider.js';
import { readSse } from './sse.js';

export interface GroqConfig {
  apiKey: string;
  model: string;
  /** Groq's free tier caps tokens per minute (~8k at time of writing), so the input budget is small. */
  maxInputChars?: number;
  baseUrl?: string;
  fetchImpl?: FetchFn;
}

interface GroqChunk {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  error?: { message?: string; type?: string; code?: string };
}

export function createGroqProvider(cfg: GroqConfig): LlmProvider {
  const baseUrl = cfg.baseUrl ?? 'https://api.groq.com';
  const fetchFn: FetchFn = cfg.fetchImpl ?? ((i, init) => fetch(i, init));

  return {
    name: 'groq',
    model: cfg.model,
    maxInputChars: cfg.maxInputChars ?? 14_000,
    async *stream(req: LlmRequest) {
      const res = await postForStream(
        fetchFn,
        `${baseUrl}/openai/v1/chat/completions`,
        { authorization: `Bearer ${cfg.apiKey}` },
        {
          model: cfg.model,
          stream: true,
          temperature: req.temperature,
          max_tokens: req.maxOutputTokens,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        },
        req.signal,
      );

      for await (const data of readSse(res.body)) {
        if (data === '[DONE]') return;
        let chunk: GroqChunk;
        try {
          chunk = JSON.parse(data) as GroqChunk;
        } catch {
          continue;
        }
        if (chunk.error) {
          const quota = /rate.?limit|quota/i.test(`${chunk.error.type ?? ''} ${chunk.error.code ?? ''}`);
          throw new AppError(quota ? 'ai_quota_exhausted' : 'ai_unavailable', { detail: `stream-error ${chunk.error.type ?? ''}` });
        }
        const choice = chunk.choices?.[0];
        const text = choice?.delta?.content;
        if (text) yield text;
        if (choice?.finish_reason === 'content_filter') throw new AppError('ai_refused', { detail: 'content_filter' });
      }
    },
  };
}
