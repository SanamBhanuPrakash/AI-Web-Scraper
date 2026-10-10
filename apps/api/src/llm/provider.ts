export type ProviderName = 'gemini' | 'groq' | 'mock';

export interface LlmRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  temperature: number;
  signal?: AbortSignal;
}

/**
 * One LLM backend. `stream` yields text chunks as they arrive and must:
 *  - throw AppError('ai_quota_exhausted' | 'ai_unavailable' | 'ai_refused') for upstream failures,
 *  - rethrow abort errors untouched (so callers can tell "client left" from "provider failed").
 */
export interface LlmProvider {
  readonly name: ProviderName;
  readonly model: string;
  /** Max characters of page text this provider should receive (quota-aware, see plan §6.5). */
  readonly maxInputChars: number;
  stream(req: LlmRequest): AsyncIterable<string>;
}
