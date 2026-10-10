import type { FailureCode } from './api';

/** Short, plain headings for each failure. The server supplies the detailed sentence. */
export const FAILURE_TITLE: Record<FailureCode, string> = {
  invalid_request: "That address can't be used",
  blocked_url: 'Address not allowed',
  not_found: 'Page not found',
  host_not_found: 'No website found there',
  too_large: 'That page is too large',
  unsupported_content_type: 'Not a web page',
  blocked_by_site: 'The site blocked the request',
  tls_error: 'Certificate problem',
  too_many_redirects: 'Too many redirects',
  js_rendered: 'This page needs JavaScript',
  access_wall: 'This page is behind a wall',
  insufficient_content: 'Not enough text to summarize',
  request_timeout: 'That took too long',
  fetch_timeout: 'The site took too long',
  site_error: "The site isn't responding",
  site_rate_limited: 'The site is limiting requests',
  rate_limited: 'Slow down for a moment',
  ai_quota_exhausted: 'AI capacity reached for now',
  ai_unavailable: 'The summarizer is unavailable',
  ai_refused: "This couldn't be summarized",
  internal_error: 'Something went wrong',
  network: "Can't reach the service",
  connection_lost: 'The connection dropped',
  bad_response: 'Unexpected response',
};

/** Failures where editing the address (not retrying the same one) is the useful next step. */
export const NEEDS_NEW_LINK = new Set<FailureCode>([
  'invalid_request',
  'blocked_url',
  'not_found',
  'host_not_found',
  'too_large',
  'unsupported_content_type',
  'blocked_by_site',
  'tls_error',
  'too_many_redirects',
  'js_rendered',
  'insufficient_content',
  'access_wall',
  'ai_refused',
]);
