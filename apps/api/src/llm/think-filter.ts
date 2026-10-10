/**
 * Reasoning models (several on Groq, Qwen/DeepSeek families) can emit their chain of thought inline as
 * <think>...</think>. That text is not part of the answer and may contain page content, so it is removed
 * from the stream before anything is parsed or shown. Handles tags split across chunks.
 */
export async function* filterThinking(source: AsyncIterable<string>): AsyncGenerator<string> {
  const OPEN = '<think>';
  const CLOSE = '</think>';
  let inThink = false;
  let buf = '';

  for await (const chunk of source) {
    buf += chunk;
    for (;;) {
      if (inThink) {
        const end = buf.indexOf(CLOSE);
        if (end === -1) {
          // Keep only a possible partial closing tag; drop the rest of the thinking text.
          buf = buf.slice(Math.max(0, buf.length - (CLOSE.length - 1)));
          break;
        }
        buf = buf.slice(end + CLOSE.length);
        inThink = false;
      } else {
        const start = buf.indexOf(OPEN);
        if (start === -1) {
          // Emit everything except a trailing fragment that could be the start of an opening tag.
          const keep = partialSuffix(buf, OPEN);
          if (buf.length - keep > 0) yield buf.slice(0, buf.length - keep);
          buf = buf.slice(buf.length - keep);
          break;
        }
        if (start > 0) yield buf.slice(0, start);
        buf = buf.slice(start + OPEN.length);
        inThink = true;
      }
    }
  }
  if (!inThink && buf.length > 0) yield buf;
}

/** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
function partialSuffix(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}
