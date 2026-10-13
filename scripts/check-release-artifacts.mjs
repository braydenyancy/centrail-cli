import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { integrity } from './release-policy.mjs';
import { checkReleaseTag } from './check-release-tag.mjs';

export function checkReleaseArtifacts(root, env = process.env) {
const release = checkReleaseTag(root,env);
const out = join(root,'.release-artifacts');
const manifest = JSON.parse(readFileSync(join(out,'manifest.json'),'utf8'));
if(manifest.version !== release.version || manifest.sourceSha !== release.sha || manifest.packedConsumers !== 'passed') throw new Error('Artifact source/version differs from reviewed tag');
if(manifest.packages.map(p=>p.name).join() !== '@centrail/parsers,centrail') throw new Error('Unexpected artifact packages/order');
for(const artifact of manifest.packages) {
  if(artifact.version !== release.version || !/^[A-Za-z0-9.-]+\.tgz$/.test(artifact.filename) || integrity(readFileSync(join(out,artifact.filename))) !== artifact.integrity) throw new Error('Tested package artifact changed');
}
for(const helper of ['release-publish.mjs','release-policy.mjs','check-release-tag.mjs','check-server-contract.mjs']) {
  const expected = integrity(readFileSync(join(root,'scripts',helper)));
  if(manifest.helpers?.[helper] !== expected || integrity(readFileSync(join(out,'publisher','scripts',helper))) !== expected) throw new Error('Minimal publishing helper differs from reviewed tag');
}
const packageJson = JSON.parse(readFileSync(join(out,'publisher','package.json'),'utf8'));
if(JSON.stringify(packageJson) !== JSON.stringify({private:true,type:'module',scripts:{'publish:verified':'node scripts/release-publish.mjs'}})) throw new Error('Unexpected publisher package entrypoint');
return release;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkReleaseArtifacts(fileURLToPath(new URL('..',import.meta.url)));
  console.log('Verified exact tested artifacts, source commit and minimal publisher helpers');
}
