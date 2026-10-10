import { z } from 'zod';

export const LENGTHS = ['short', 'medium', 'long'] as const;
export const FORMATS = ['paragraph', 'bullets'] as const;

/** Request body of POST /api/summarize. The URL is re-validated server-side by the SSRF policy. */
export const SummarizeRequestSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  length: z.enum(LENGTHS).default('medium'),
  format: z.enum(FORMATS).default('bullets'),
  language: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Expected a BCP-47 language tag')
    .max(35)
    .optional(),
});

export type SummarizeRequest = z.infer<typeof SummarizeRequestSchema>;

export type Confidence = 'high' | 'medium' | 'low';
export type ExtractionMethod = 'readability' | 'semantic-fallback' | 'body-fallback' | 'salvage';

export interface PageInfo {
  url: string;
  finalUrl: string;
  title: string;
  siteName?: string;
  author?: string;
  publishedAt?: string;
  lang?: string;
  favicon?: string;
  wordCount: number;
  readingMinutes: number;
  usedWords: number;
  truncated: boolean;
  confidence: Confidence;
  extractionMethod: ExtractionMethod;
}
