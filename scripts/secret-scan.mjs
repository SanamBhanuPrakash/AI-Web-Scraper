// Fails (exit 1) if anything that looks like a real API key is found in files that could be committed.
// Usage (from repo root):  node scripts/secret-scan.mjs
// Run it BEFORE `git add`/`git commit`. It never prints the secret itself, only file:line and the key type.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', 'coverage', '.vercel']);
const SKIP_FILES = new Set(['.env', 'PROJECT_LOG.md', 'CLAUDE.md', 'package-lock.json']);
const PATTERNS = [
  ['Google/Gemini API key', /AIza[0-9A-Za-z_-]{30,}/],
  ['Google AI Studio key', /\bAQ\.[0-9A-Za-z_-]{30,}/],
  ['Groq API key', /\bgsk_[0-9A-Za-z]{30,}/],
  ['OpenAI-style key', /\bsk-[0-9A-Za-z_-]{30,}/],
  ['Upstash/Bearer token', /Bearer\s+[A-Za-z0-9._~+/-]{30,}/],
  ['Private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Key assigned in env-style line', /^[A-Z0-9_]*(API_KEY|TOKEN|SECRET)\s*=\s*[^\s#]{12,}/m],
];

const hits = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (st.size < 2_000_000) scan(full);
  }
}
function scan(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  if (text.includes('\u0000')) return; // binary
  text.split('\n').forEach((line, i) => {
    for (const [label, re] of PATTERNS) {
      if (re.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}  ${label}`);
    }
  });
}

walk(ROOT);
if (hits.length > 0) {
  console.error('Possible secrets found (values not shown):\n  ' + [...new Set(hits)].join('\n  '));
  process.exit(1);
}
console.log('secret-scan: clean');
