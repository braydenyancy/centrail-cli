import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alignedVersion, integrity } from './release-policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run release:pack');
const out = resolve(root, '.release-artifacts');
mkdirSync(out, { recursive: true });
const version = alignedVersion(root);
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== 0) throw new Error(`Packed consumer command failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
const packages = [];
for (const workspace of ['@centrail/parsers', 'centrail']) {
  const [pack] = JSON.parse(run([npm, 'pack', '--workspace', workspace, '--ignore-scripts', '--json', '--pack-destination', out]));
  const bytes = readFileSync(join(out, pack.filename));
  if (pack.version !== version || pack.name !== workspace || integrity(bytes) !== pack.integrity) throw new Error('Packed artifact identity mismatch');
  packages.push({ name: workspace, version, filename: pack.filename, integrity: pack.integrity, files: pack.files.map(f => f.path) });
}
const consumer = mkdtempSync(join(tmpdir(), 'centrail-packed-'));
try {
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run([npm, 'install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--package-lock=false', ...packages.map(p => join(out, p.filename))], consumer);
  const cli = run([join(consumer, 'node_modules', 'centrail', 'dist', 'index.js')], consumer);
  if (!cli.includes('centrail sync')) throw new Error('Packed CLI usage smoke failed');
  const parser = pathToFileURL(join(consumer, 'node_modules', '@centrail', 'parsers', 'dist', 'index.js')).href;
  run(['--input-type=module', '-e', `const p = await import(${JSON.stringify(parser)}); for (const n of ['scanClaudeCodeLogs','scanCodexLogs','scanCopilotLogs','scanPiLogs','scanGeminiLogs']) if(typeof p[n] !== 'function') throw new Error(n);`], consumer);
} finally { rmSync(consumer, { recursive: true, force: true }); }
const helpers = {};
mkdirSync(join(out,'publisher','scripts'),{recursive:true});
for (const helper of ['release-publish.mjs','release-policy.mjs','check-release-tag.mjs','check-server-contract.mjs']) {
  copyFileSync(join(root,'scripts',helper),join(out,'publisher','scripts',helper));
  helpers[helper] = integrity(readFileSync(join(root,'scripts',helper)));
}
writeFileSync(join(out,'publisher','package.json'),JSON.stringify({private:true,type:'module',scripts:{'publish:verified':'node scripts/release-publish.mjs'}})+'\n');
const source = spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});
if(source.status !== 0) throw new Error('Packed source commit unavailable');
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ version, sourceSha:source.stdout.trim(), node: process.version, packedConsumers: 'passed', packages, helpers }, null, 2) + '\n');
console.log(`Packed consumers passed: ${version}; exact artifacts retained in .release-artifacts`);
