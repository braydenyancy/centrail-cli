import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, existingVersion, integrity } from './release-policy.mjs';
import { checkReleaseTag } from './check-release-tag.mjs';

const root = resolve(process.env.CENTRAIL_RELEASE_CHECKOUT ?? fileURLToPath(new URL('..', import.meta.url)));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run release:publish');
const { version, channel, sha } = checkReleaseTag(root);
const git = (...args) => {
  const p = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (p.error || p.status !== 0) throw new Error('Tag must identify a commit already reviewed on main');
  return p.stdout.trim();
};
const out = join(root, '.release-artifacts');
const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
if (manifest.version !== version || manifest.sourceSha !== sha || manifest.packedConsumers !== 'passed' || manifest.packages.map(p => p.name).join() !== '@centrail/parsers,centrail') throw new Error('Packed manifest mismatch');
function npmRun(args) {
  const p = spawnSync(process.execPath, [npm, ...args], { cwd: root, encoding: 'utf8', timeout: 180000, stdio: 'inherit' });
  if (p.error || p.status !== 0) throw new Error('npm publication command failed');
}
async function metadata(name) {
  const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!r.ok) throw new Error(`npm metadata unavailable: ${r.status}`);
  return r.json();
}
async function checkBytes(record, artifact) {
  if (!existingVersion(record, artifact.integrity)) throw new Error('Published version did not appear in the registry');
  const url = new URL(record.dist.tarball);
  if (url.origin !== 'https://registry.npmjs.org') throw new Error('Unexpected registry tarball origin');
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!r.ok || integrity(Buffer.from(await r.arrayBuffer())) !== artifact.integrity) throw new Error('Public tarball bytes differ from tested artifact');
}
const receipt = { version, channel, sha, packages: [], provenance: 'npm publish --provenance requested; no independent signature-chain verification' };
for (const artifact of manifest.packages) {
  if (artifact.version !== version || integrity(readFileSync(join(out, artifact.filename))) !== artifact.integrity) throw new Error('Retained artifact changed');
  const before = await metadata(artifact.name);
  const current = before['dist-tags']?.[channel];
  if (current && compareVersions(current, version) > 0) throw new Error('Refusing to move npm channel backward');
  const exists = existingVersion(before.versions?.[version], artifact.integrity);
  if (!exists) npmRun(['publish', join(out, artifact.filename), '--ignore-scripts', '--access', 'public', '--provenance', '--tag', channel]);
  let after;
  for (let attempt = 0; attempt < 12; attempt++) {
    after = await metadata(artifact.name);
    if (after.versions?.[version]) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  await checkBytes(after?.versions?.[version], artifact);
  if (after['dist-tags']?.[channel] !== version) {
    const previous = after['dist-tags']?.[channel];
    if (previous && compareVersions(previous, version) > 0) throw new Error('Newer channel appeared; refusing downgrade');
    npmRun(['dist-tag', 'add', `${artifact.name}@${version}`, channel]);
    after = await metadata(artifact.name);
    if (after['dist-tags']?.[channel] !== version) throw new Error('Registry channel verification failed');
  }
  receipt.packages.push({ name: artifact.name, integrity: artifact.integrity, existing: exists, bytesVerified: true, channelVerified: true });
  writeFileSync(join(out, 'publication.json'), JSON.stringify(receipt, null, 2) + '\n');
}
if (channel === 'latest') git('push', 'origin', `${sha}:refs/heads/release`);
console.log(`Verified both packages under ${channel}; ${channel === 'latest' ? 'stable plugin advanced' : 'stable plugin unchanged'}`);
