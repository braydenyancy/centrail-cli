import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const number = '(?:0|[1-9][0-9]*)';
const semver = new RegExp(`^(${number})\\.(${number})\\.(${number})(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`);
export function parseVersion(version) {
  const match = semver.exec(version);
  if (!match || match[4]?.split('.').some(part => /^0[0-9]+$/.test(part))) throw new Error('Invalid release semver');
  return { version, numbers: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split('.') ?? [] };
}
export function compareVersions(a, b) {
  a = parseVersion(a); b = parseVersion(b);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1;
  if (!a.prerelease.length || !b.prerelease.length) return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^[0-9]+$/.test(x), yn = /^[0-9]+$/.test(y);
    if (xn !== yn) return xn ? -1 : 1;
    return xn ? (BigInt(x) > BigInt(y) ? 1 : -1) : (x > y ? 1 : -1);
  }
  return 0;
}
export function releaseTag(ref, refType, event) {
  if (!['push', 'workflow_dispatch'].includes(event) || refType !== 'tag' || !ref?.startsWith('refs/tags/v')) throw new Error('Publication requires a v* tag ref');
  const version = ref.slice('refs/tags/v'.length);
  const parsed = parseVersion(version);
  return { version, channel: parsed.prerelease.length ? 'next' : 'latest' };
}
export function integrity(bytes) { return `sha512-${createHash('sha512').update(bytes).digest('base64')}`; }
export function existingVersion(metadata, expectedIntegrity) {
  if (!metadata) return false;
  if (metadata.dist?.integrity !== expectedIntegrity) throw new Error('Existing immutable npm version differs from retained tarball');
  return true;
}
export function alignedVersion(root, { published = false } = {}) {
  const json = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const cli = json('packages/cli/package.json').version;
  parseVersion(cli);
  const versions = [json('packages/parsers/package.json').version, json('plugins/centrail/.claude-plugin/plugin.json').version,
    json('.claude-plugin/marketplace.json').metadata.version,
    json('package-lock.json').packages['packages/cli'].version,
    json('package-lock.json').packages['packages/parsers'].version,
    /export const CLI_VERSION = "([^"]+)"/.exec(readFileSync(join(root, 'packages/cli/src/version.ts'), 'utf8'))?.[1]];
  if (published) versions.push(readFileSync(join(root, 'version.txt'), 'utf8').trim(), json('.release-please-manifest.json')['.']);
  if (versions.some(v => v !== cli)) throw new Error('Release versions do not agree');
  return cli;
}
