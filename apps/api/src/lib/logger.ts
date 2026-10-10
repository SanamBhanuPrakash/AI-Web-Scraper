type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Defence in depth: never let something that looks like a credential reach the logs.
const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /gsk_[0-9A-Za-z]{20,}/g, // Groq keys
  /(Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi,
  /(api[_-]?key["'=:\s]+)[^\s"',}]{8,}/gi,
];

export function redact(input: string): string {
  return SECRET_PATTERNS.reduce((s, re) => s.replace(re, (_m, p1) => `${typeof p1 === 'string' ? p1 : ''}[REDACTED]`), input);
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(
  level: Level = 'info',
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (l) => process.stdout.write(l + '\n'),
): Logger {
  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...base, ...fields });
    sink(redact(line));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => createLogger(level, { ...base, ...f }, sink),
  };
}
