/**
 * Single source of truth for API error codes, shared by API and UI.
 * `status` is the HTTP status; `retryable` tells the UI whether a "Try again" makes sense.
 * Messages are written for end users: no internal hostnames, paths, or stack traces.
 */
export const ERROR_CODES = {
  invalid_request: {
    status: 400,
    retryable: false,
    message: "That doesn't look like a valid web address.",
  },
  blocked_url: {
    status: 400,
    retryable: false,
    message:
      'Digest only fetches public web pages. Private, internal and non-web addresses are blocked.',
  },
  not_found: {
    status: 404,
    retryable: false,
    message: "The site says this page doesn't exist. Check the address for typos.",
  },
  host_not_found: {
    status: 422,
    retryable: false,
    message: "We couldn't find a website at that address.",
  },
  too_large: { status: 413, retryable: false, message: 'That page is too large to process.' },
  unsupported_content_type: {
    status: 415,
    retryable: false,
    message: 'We can only summarize web pages (HTML or plain text).',
  },
  blocked_by_site: {
    status: 422,
    retryable: false,
    message: 'The site refused our request. It may block automated access.',
  },
  tls_error: {
    status: 422,
    retryable: false,
    message: "The site's security certificate could not be verified.",
  },
  too_many_redirects: {
    status: 422,
    retryable: false,
    message: 'The address redirected too many times.',
  },
  js_rendered: {
    status: 422,
    retryable: false,
    message:
      "This page builds its content with JavaScript, which we can't run. Try a different page, or the site's article/AMP version.",
  },
  access_wall: {
    status: 422,
    retryable: false,
    message:
      'This page shows a cookie, consent or sign-in wall instead of its content, so only the wall could be read.',
  },
  insufficient_content: {
    status: 422,
    retryable: false,
    message: "We couldn't find enough readable text on this page.",
  },
  request_timeout: {
    status: 504,
    retryable: true,
    message: 'That took too long. Please try again.',
  },
  fetch_timeout: { status: 504, retryable: true, message: 'The site took too long to respond.' },
  site_error: {
    status: 502,
    retryable: true,
    message: 'The site is having trouble. Try again shortly.',
  },
  site_rate_limited: {
    status: 502,
    retryable: true,
    message: 'The site is rate limiting us. Try again shortly.',
  },
  rate_limited: {
    status: 429,
    retryable: true,
    message: "You're going fast. Please wait a moment.",
  },
  ai_quota_exhausted: {
    status: 503,
    retryable: true,
    message: "Today's free AI capacity has been used up. Please try again later.",
  },
  ai_unavailable: {
    status: 502,
    retryable: true,
    message: 'The AI service is temporarily unavailable.',
  },
  ai_refused: { status: 422, retryable: false, message: "The AI couldn't summarize this content." },
  internal_error: { status: 500, retryable: true, message: 'Something went wrong on our side.' },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ApiErrorBody {
  requestId: string;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    retryAfterSec?: number;
  };
}
