export type ProviderName = 'gemini' | 'groq' | 'mock';

export interface LlmRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  temperature: number;
  /** Ask the model for a single JSON object (used by the reading pass). */
  json?: boolean;
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
  /** Hardware-accelerated inference: preferred first when the input is small enough to fit its budget. */
  readonly fast?: boolean;
  stream(req: LlmRequest): AsyncIterable<string>;
}
