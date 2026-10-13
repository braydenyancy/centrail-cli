import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { alignedVersion, compareVersions, existingVersion, integrity, releaseTag } from './release-policy.mjs';
import { checkReleaseTag } from './check-release-tag.mjs';
import { checkReleaseArtifacts } from './check-release-artifacts.mjs';

for (const event of ['push', 'workflow_dispatch']) {
  test(`${event} stable tag selects latest`, () => assert.deepEqual(releaseTag('refs/tags/v0.8.0', 'tag', event), { version: '0.8.0', channel: 'latest' }));
  test(`${event} prerelease tag selects next`, () => assert.equal(releaseTag('refs/tags/v0.8.0-next.2', 'tag', event).channel, 'next'));
  test(`${event} branch publication fails closed`, () => assert.throws(() => releaseTag('refs/heads/main', 'branch', event), /tag ref/));
}
for (const tag of ['v01.2.3', 'v0.8.0-next.01', 'v0.8.0+build.1', 'v0.8.0-']) test(`reject malformed tag ${tag}`, () => assert.throws(() => releaseTag(`refs/tags/${tag}`, 'tag', 'push')));
test('pull request publication fails closed', () => assert.throws(() => releaseTag('refs/tags/v0.8.0', 'tag', 'pull_request')));
test('partial publication retry verifies immutable bytes', () => {
  const expected = integrity(Buffer.from('retained tested tarball'));
  assert.equal(existingVersion(undefined, expected), false);
  assert.equal(existingVersion({ dist: { integrity: expected } }, expected), true);
  assert.throws(() => existingVersion({ dist: { integrity: integrity(Buffer.from('other bytes')) } }, expected), /immutable/);
});
test('registry channel order prevents stale retry and sorts prereleases numerically', () => {
  for (const [a,b] of [['0.8.1','0.8.0'], ['0.8.0','0.8.0-next.10'], ['0.8.0-next.10','0.8.0-next.2'], ['0.8.0-next.2','0.8.0-next.1'], ['0.8.0-next.a','0.8.0-next.1']]) {
    assert.equal(compareVersions(a,b), 1); assert.equal(compareVersions(b,a), -1); assert.equal(compareVersions(a,a), 0);
  }
});
test('package, plugin, marketplace, lock and runtime versions remain coordinated', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  assert.ok(alignedVersion(root));
  const temp = mkdtempSync(join(tmpdir(), 'centrail-versions-'));
  const files = ['packages/cli/package.json','packages/parsers/package.json','plugins/centrail/.claude-plugin/plugin.json','plugins/centrail/.codex-plugin/plugin.json','.claude-plugin/marketplace.json','package-lock.json','packages/cli/src/version.ts','version.txt','.release-please-manifest.json'];
  try {
    for (const file of files) { mkdirSync(dirname(join(temp,file)), { recursive:true }); writeFileSync(join(temp,file), readFileSync(join(root,file))); }
    assert.ok(alignedVersion(temp));
    writeFileSync(join(temp,'version.txt'),'0.0.1\n');
    writeFileSync(join(temp,'.release-please-manifest.json'),JSON.stringify({'.':'0.0.1'}));
    assert.throws(() => alignedVersion(temp, {published:true}), /agree/);
    const version = alignedVersion(temp);
    writeFileSync(join(temp,'version.txt'), version+'\n');
    writeFileSync(join(temp,'.release-please-manifest.json'),JSON.stringify({'.':version}));
    assert.equal(alignedVersion(temp,{published:true}),version);
    const path = join(temp,'plugins/centrail/.claude-plugin/plugin.json');
    const plugin = JSON.parse(readFileSync(path)); plugin.version = '0.0.1'; writeFileSync(path,JSON.stringify(plugin));
    assert.throws(() => alignedVersion(temp), /agree/);
  } finally { rmSync(temp,{recursive:true,force:true}); }
});
test('actual tag checkout must be in reviewed main history', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const temp = mkdtempSync(join(tmpdir(),'centrail-tag-'));
  const files = ['packages/cli/package.json','packages/parsers/package.json','plugins/centrail/.claude-plugin/plugin.json','plugins/centrail/.codex-plugin/plugin.json','.claude-plugin/marketplace.json','package-lock.json','packages/cli/src/version.ts'];
  const helpers = ['release-publish.mjs','release-policy.mjs','check-release-tag.mjs','check-server-contract.mjs'];
  files.push(...helpers.map(name=>join('scripts',name)));
  const git = (...args) => {
    const r = spawnSync('git',args,{cwd:temp,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr); return r.stdout.trim();
  };
  try {
    for(const file of files) {mkdirSync(dirname(join(temp,file)),{recursive:true});writeFileSync(join(temp,file),readFileSync(join(root,file)));}
    const version = alignedVersion(temp);
    writeFileSync(join(temp,'version.txt'),version+'\n');
    writeFileSync(join(temp,'.release-please-manifest.json'),JSON.stringify({'.':version}));
    git('init');git('config','user.name','Fixture Maintainer');git('config','user.email','fixture@example.invalid');
    git('add','.');git('commit','-m','Fixture baseline');
    const sha = git('rev-parse','HEAD');
    git('update-ref','refs/remotes/origin/main',sha);git('tag',`v${version}`);
    const env = {GITHUB_REF:`refs/tags/v${version}`,GITHUB_REF_TYPE:'tag',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_SHA:sha,GITHUB_REPOSITORY:'braydenyancy/centrail-cli'};
    assert.equal(checkReleaseTag(temp,env).sha,sha);
    const out = join(temp,'.release-artifacts');
    mkdirSync(join(out,'publisher','scripts'),{recursive:true});
    const bytes = Buffer.from('retained package bytes');
    const packages = ['@centrail/parsers','centrail'].map((name,i)=>({name,version,filename:`package${i}.tgz`,integrity:integrity(bytes)}));
    for(const artifact of packages) writeFileSync(join(out,artifact.filename),bytes);
    const hashes = {};
    for(const helper of helpers) {const content = readFileSync(join(temp,'scripts',helper));hashes[helper]=integrity(content);writeFileSync(join(out,'publisher','scripts',helper),content);}
    writeFileSync(join(out,'publisher','package.json'),JSON.stringify({private:true,type:'module',scripts:{'publish:verified':'node scripts/release-publish.mjs'}}));
    writeFileSync(join(out,'manifest.json'),JSON.stringify({version,sourceSha:sha,packedConsumers:'passed',packages,helpers:hashes}));
    assert.equal(checkReleaseArtifacts(temp,env).sha,sha);
    writeFileSync(join(out,packages[0].filename),'modified tarball');
    assert.throws(()=>checkReleaseArtifacts(temp,env),/artifact changed/);
    writeFileSync(join(out,packages[0].filename),bytes);
    writeFileSync(join(out,'publisher','scripts',helpers[0]),'modified publisher');
    assert.throws(()=>checkReleaseArtifacts(temp,env),/helper differs/);
    assert.throws(()=>checkReleaseTag(temp,{...env,GITHUB_SHA:'0'.repeat(40)}),/identity/);
    assert.throws(()=>checkReleaseTag(temp,{...env,GITHUB_REPOSITORY:'other/repo'}),/repository/);
    git('commit','--allow-empty','-m','Off-main fixture');git('tag','-f',`v${version}`);
    assert.throws(()=>checkReleaseTag(temp,{...env,GITHUB_SHA:git('rev-parse','HEAD')}),/reviewed on main/);
  } finally {rmSync(temp,{recursive:true,force:true});}
});
