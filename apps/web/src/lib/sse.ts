export interface SseMessage {
  event: string;
  data: string;
}

/** Incremental Server-Sent-Events parser (works on text chunks of any size, CRLF or LF). */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const m = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
      if (!m) break;
      const block = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const msg = parseBlock(block);
      if (msg) out.push(msg);
    }
    return out;
  }

  /** Flush a final event that was not followed by a blank line. */
  end(): SseMessage[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    const msg = rest ? parseBlock(rest) : undefined;
    return msg ? [msg] : [];
  }
}

function parseBlock(block: string): SseMessage | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (line === '' || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length === 0 ? undefined : { event, data: data.join('\n') };
}
