import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isBlockedIp } from '../src/pipeline/ip-policy.js';
import type { UrlPolicy } from '../src/pipeline/validate-url.js';

/**
 * Permissive policy for integration tests ONLY: allows the loopback test server and any port,
 * but still blocks every other private range (so redirects to e.g. 169.254.169.254 are testable).
 * Production code can never obtain this: policy is a constructor argument, not env config (ADR-015).
 */
export const TEST_POLICY: UrlPolicy = {
  allowedPorts: 'any',
  allowedProtocols: ['http:', 'https:'],
  ownHosts: [],
  isBlockedIp: (ip) => ip !== '127.0.0.1' && isBlockedIp(ip),
  blockNonPublicNames: false,
  maxUrlLength: 2048,
};

export interface TestServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(handler: http.RequestListener): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const html = (body: string, title = 'Test page') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

/** Realistic multi-paragraph prose used to build article fixtures. */
export const PROSE = [
  'Web scraping is the automated extraction of data from websites. A scraper requests a page over HTTP, receives markup, and then pulls out the pieces of text or structured data that matter to the caller.',
  'Modern sites complicate that picture. Some deliver finished HTML from the server, while others ship an almost empty document and assemble the page in the browser with JavaScript, which a simple HTTP client cannot execute.',
  'Responsible scrapers identify themselves honestly, limit how often they connect, cap how much they download, and refuse to follow links into private networks, because a server that fetches arbitrary addresses on behalf of strangers can be abused to reach internal services.',
  'Extraction itself is a ranking problem. Navigation menus, cookie banners, advertisements and footers surround the article, and the extractor must decide which block of the document is the main content by scoring paragraphs, link density and text length.',
  'Once the main text has been isolated it can be passed to a language model. Because the page is untrusted input, the prompt must treat it strictly as data and never as instructions, and the output must be rendered as plain text.',
  'Finally, results should be honest about their limits. When a page is truncated for length, or when the extractor is unsure it found the real article, the interface should say so instead of presenting a confident summary of the wrong text.',
];
