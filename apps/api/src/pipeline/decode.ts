/** Bytes -> string using the same precedence browsers use: BOM, HTTP header, <meta>, then UTF-8. */
export function decodeBody(
  bytes: Uint8Array,
  contentTypeHeader = '',
): { text: string; charset: string } {
  const bom = detectBom(bytes);
  const charset = bom ?? fromHeader(contentTypeHeader) ?? sniffMeta(bytes) ?? 'utf-8';
  return { text: decodeWith(bytes, charset), charset };
}

function detectBom(b: Uint8Array): string | undefined {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8';
  if (b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
  if (b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
  return undefined;
}

function normalizeLabel(raw: string): string | undefined {
  const label = raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
  if (!label) return undefined;
  try {
    new TextDecoder(label); // throws RangeError for unknown labels
    return label;
  } catch {
    return undefined;
  }
}

function fromHeader(header: string): string | undefined {
  const m = /charset\s*=\s*([^;\s]+)/i.exec(header);
  return m?.[1] ? normalizeLabel(m[1]) : undefined;
}

function sniffMeta(bytes: Uint8Array): string | undefined {
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1');
  const direct = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head);
  if (direct?.[1]) return normalizeLabel(direct[1]);
  const http =
    /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset=([a-z0-9_:.-]+)/i.exec(
      head,
    );
  return http?.[1] ? normalizeLabel(http[1]) : undefined;
}

function decodeWith(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}
