// Source hygiene gate (run in CI and before commits):
//  1. No stray control characters in source files (they usually come from a botched escape).
//  2. No literal invisible / bidi / tag characters in source (they can hide logic or instructions: write \uXXXX).
//  3. No em or en dashes in user-visible copy (design rule, see DESIGN.md).
//  4. Code that runs inside the serverless function never imports the workspace package `@digest/shared` by name
//     (its entry is TypeScript, which Node cannot load from node_modules). Use apps/api/src/shared.ts instead.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.claude',
  'coverage',
  'test-results',
  'playwright-report',
  '.vercel',
]);
const SOURCE = /\.(ts|tsx|mjs|js|cjs|css|html|json|md|yml|yaml)$/;
const SKIP_FILES = new Set(['package-lock.json', 'sample.json', 'PROJECT_LOG.md', 'plan.md']);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const INVISIBLE =
  /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e007f}]/u;
const DASH = /[\u2014\u2013]/;
// Files whose strings the user reads.
const COPY_FILES = [
  /^apps\/web\/src\/.*\.(tsx|css)$/,
  /^apps\/web\/src\/lib\/errors-copy\.ts$/,
  /^apps\/web\/index\.html$/,
  /^packages\/shared\/src\/errors\.ts$/,
];

// Files that end up in the Vercel function. Tests and scripts run under tsx/vitest and are not bundled.
const SERVERLESS = /^(api\/.*|apps\/api\/src\/(?!shared\.ts$).*)\.ts$/;
const BARE_SHARED = /from\s+['"]@digest\/shared['"]/;

const problems = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (SOURCE.test(name) && !SKIP_FILES.has(name)) check(p);
  }
}

function check(file) {
  const rel = relative(ROOT, file).replaceAll('\\', '/');
  const isCopy = COPY_FILES.some((re) => re.test(rel));
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (CONTROL.test(line)) problems.push(`${rel}:${i + 1}  stray control character`);
      if (INVISIBLE.test(line))
        problems.push(`${rel}:${i + 1}  literal invisible character (use a \\u escape)`);
      if (SERVERLESS.test(rel) && BARE_SHARED.test(line))
        problems.push(`${rel}:${i + 1}  imports @digest/shared by name; use apps/api/src/shared.ts`);
      if (isCopy && DASH.test(line))
        problems.push(`${rel}:${i + 1}  em/en dash in user-visible copy`);
    });
}

walk(ROOT);
if (problems.length > 0) {
  console.error('Source hygiene problems:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('hygiene: clean');
