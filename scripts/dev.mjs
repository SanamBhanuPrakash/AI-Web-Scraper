// One command for local development: API on :8787 and web on :5173 (the web dev server proxies /api to the API).
// Without API keys it starts in offline demo mode (DIGEST_MOCK_LLM=1) so the whole product still runs.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const ENV_FILE = new URL('../.env', import.meta.url);

function hasKey() {
  const fromEnv = (k) => (process.env[k] ?? '').trim() !== '';
  if (fromEnv('GEMINI_API_KEY') || fromEnv('GROQ_API_KEY')) return true;
  if (!existsSync(ENV_FILE)) return false;
  return readFileSync(ENV_FILE, 'utf8')
    .split(/\r?\n/)
    .some((line) => /^\s*(GEMINI|GROQ)_API_KEY\s*=\s*\S+/.test(line));
}

const demo = !hasKey() && process.env.DIGEST_MOCK_LLM !== '1';
const env = { ...process.env, ...(demo ? { DIGEST_MOCK_LLM: '1' } : {}) };

const C = { api: '\x1b[36m', web: '\x1b[35m', reset: '\x1b[0m', dim: '\x1b[2m' };
console.log(`${C.dim}Digest dev: API http://localhost:8787, web http://localhost:5173${C.reset}`);
if (demo) {
  console.log(
    'No AI key found in .env, so the API runs in offline demo mode (a simple extractive summarizer).',
  );
  console.log(
    'For real summaries: copy .env.example to .env and add a free GEMINI_API_KEY and/or GROQ_API_KEY.\n',
  );
}

const children = [];
let shuttingDown = false;

function run(name, args) {
  const child = spawn('npm', args, { env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `${C[name]}[${name}]${C.reset} `;
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim() !== '') process.stdout.write(tag + l + '\n');
    });
  }
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`${tag}exited with code ${code}`);
      shutdown(code ?? 1);
    }
  });
  children.push(child);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      if (process.platform === 'win32')
        spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      else c.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('api', ['run', 'dev', '-w', '@digest/api']);
run('web', ['run', 'dev', '-w', '@digest/web']);
