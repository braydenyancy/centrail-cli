// Run from the repository root: node --test scripts/check-doc-links.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./check-doc-links.mjs', import.meta.url));
const cases = [
  ['ordinary link', '[ok](target.md#heading)', true, 1],
  ['duplicate heading', '# Hello\n# Hello\n[ok](#hello-1)', true, 1],
  ['slug collision', '# Hello\n# Hello\n# Hello-1\n[ok](#hello-1-1)', true, 1],
  ['code in heading', '# Use `foo()`\n[ok](#use-foo)', true, 1],
  ['inline code example', 'Example: `[text](missing.md)`', true, 0],
  ['fenced code example', '```md\n[text](missing.md)\n```', true, 0],
  ['parenthesized filename', '[ok](a(b).md)', true, 1],
  ['nested parenthesized filename', '[ok](a(b(c)).md)', true, 1],
  ['reference link', '[ok][ref]\n[ref]: target.md#heading', true, 1],
  ['missing file', '[bad](missing.md)', false, 1],
  ['missing nested destination', '[bad](missing(a(b)).md)', false, 1],
  ['missing anchor', '[bad](target.md#missing)', false, 1],
  ['missing reference anchor', '[bad][ref]\n[ref]: target.md#missing', false, 1],
];

for (const [name, markdown, valid, links] of cases) {
  test(name, () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'doc links test ')));
    try {
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (/^GIT_/i.test(key) || key === 'NODE_OPTIONS') delete env[key];
      }
      const gitConfig = join(root, 'empty-git-config');
      writeFileSync(gitConfig, '');
      env.GIT_CONFIG_GLOBAL = gitConfig;
      env.GIT_CONFIG_NOSYSTEM = '1';
      execFileSync('git', ['-c', 'init.templateDir=', 'init', '--quiet', root], { env });
      writeFileSync(join(root, 'test.md'), markdown);
      for (const file of ['target.md', 'a(b).md', 'a(b(c)).md']) {
        writeFileSync(join(root, file), '# Heading\n');
      }
      const result = spawnSync(process.execPath, [checker], {
        cwd: root, env, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, valid ? 0 : 1, result.stdout + result.stderr);
      assert.ok(result.stdout.includes(`${links} local links;`), result.stdout);
      if (!valid) assert.match(result.stderr, /missing/);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
