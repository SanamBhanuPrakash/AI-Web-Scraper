const MAX_EVENT_BYTES = 1_000_000;

/**
 * Minimal, strict Server-Sent-Events reader. Yields the `data` payload of each event.
 * Handles chunk boundaries inside lines/events, CRLF, multi-line data, comments, and caps event size.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let dataLines: string[] = [];
  let eventBytes = 0;

  const flush = (): string | undefined => {
    if (dataLines.length === 0) return undefined;
    const payload = dataLines.join('\n');
    dataLines = [];
    eventBytes = 0;
    return payload;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();

      let nl: number;
      while ((nl = buffer.search(/\r\n|\n|\r/)) !== -1) {
        const sep = buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? 2 : 1;
        // A lone trailing "\r" may be the first half of "\r\n": wait for more data unless the stream ended.
        if (buffer[nl] === '\r' && nl === buffer.length - 1 && !done) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + sep);

        if (line === '') {
          const ev = flush();
          if (ev !== undefined) yield ev;
          continue;
        }
        if (line.startsWith(':')) continue; // comment / keep-alive
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        if (field !== 'data') continue; // event/id/retry are not used by our providers
        let v = colon === -1 ? '' : line.slice(colon + 1);
        if (v.startsWith(' ')) v = v.slice(1);
        eventBytes += v.length;
        if (eventBytes > MAX_EVENT_BYTES) throw new Error('SSE event too large');
        dataLines.push(v);
      }
      if (buffer.length > MAX_EVENT_BYTES) throw new Error('SSE line too large');
      if (done) break;
    }
    // Stream ended without a trailing blank line: deliver what we have (providers sometimes do this).
    if (buffer.length > 0 && buffer.startsWith('data:')) dataLines.push(buffer.slice(5).replace(/^ /, ''));
    const last = flush();
    if (last !== undefined) yield last;
  } finally {
    reader.cancel().catch(() => undefined);
    reader.releaseLock?.();
  }
}
