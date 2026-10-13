import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { alignedVersion, releaseTag } from './release-policy.mjs';

export function checkReleaseTag(root, env = process.env) {
  const { version, channel } = releaseTag(env.GITHUB_REF, env.GITHUB_REF_TYPE, env.GITHUB_EVENT_NAME);
  if (env.GITHUB_REPOSITORY !== 'braydenyancy/centrail-cli') throw new Error('Unexpected publisher repository');
  if (alignedVersion(root, { published: true }) !== version) throw new Error('Tag and reviewed version differ');
  const git = (...args) => {
    const p = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (p.error || p.status !== 0) throw new Error('Tag must identify a commit already reviewed on main');
    return p.stdout.trim();
  };
  const sha = git('rev-parse', 'HEAD');
  if (git('rev-parse', `${env.GITHUB_REF}^{commit}`) !== sha || env.GITHUB_SHA !== sha) throw new Error('Tag checkout identity mismatch');
  git('merge-base', '--is-ancestor', sha, 'origin/main');
  if (channel === 'latest' && spawnSync('git', ['rev-parse', '--verify', 'origin/release'], { cwd: root, stdio: 'ignore' }).status === 0) git('merge-base', '--is-ancestor', 'origin/release', sha);
  return { version, channel, sha };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(checkReleaseTag(fileURLToPath(new URL('..', import.meta.url)))));
}
