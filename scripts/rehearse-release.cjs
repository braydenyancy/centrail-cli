const sdkPath = require('node:path').resolve(process.argv[2]);
const { GitHub, Manifest } = require(sdkPath);
const sdkVersion = require(require('node:path').join(sdkPath, 'package.json')).version;
if (sdkVersion !== '17.3.0') throw Error('Rehearsal requires the pinned action SDK17.3.0');
const { spawnSync } = require('node:child_process');
const { readFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { join, dirname, resolve } = require('node:path');
(async()=>{
 const [repo, root, out] = process.argv.slice(3);
 if(!repo || !root || !out) throw Error('Usage: repo localRoot outDir');
 const tokenResult=spawnSync('gh',['auth','token'],{encoding:'utf8'});
 if(tokenResult.status!==0)throw Error('Existing GitHub login unavailable');
 const [owner,name]=repo.split('/');
 const github=await GitHub.create({owner,repo:name,defaultBranch:'main',token:tokenResult.stdout.trim()});
 const original=github.getFileContentsOnBranch.bind(github);
 github.getFileContentsOnBranch=async(path,branch)=>{
  if(branch==='main' && existsSync(join(root,path))){const parsedContent=readFileSync(join(root,path),'utf8');return{parsedContent,content:Buffer.from(parsedContent).toString('base64'),sha:'local-rehearsal'};}
  return original(path,branch);
 };
 github.getFileContents=path=>github.getFileContentsOnBranch(path,'main');
 const manifest=await Manifest.fromManifest(github,'main');
 const prs=await manifest.buildPullRequests();
 const result=[];
 for(const pr of prs){
  const files=[];
  for(const u of pr.updates){
   const path=join(root,u.path);const old=existsSync(path)?readFileSync(path,'utf8'):u.cachedFileContents?.parsedContent;
   if(old===undefined && !u.createIfMissing) continue;
   const content=u.updater.updateContent(old);
   const dest=resolve(out,u.path);if(!dest.startsWith(resolve(out)+require('node:path').sep))throw Error('Unsafe update path');
   mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,content);files.push(u.path);
  }
  result.push({version:pr.version?.toString(),title:pr.title.toString(),body:pr.body.toString(),branch:pr.headRefName,files});
 }
 mkdirSync(out,{recursive:true});writeFileSync(join(out,'receipt.json'),JSON.stringify({sdk:sdkVersion,repo,prs:result},null,2)+'\n');
 console.log(JSON.stringify(result.map(({version,title,files})=>({version,title,files})),null,2));
})().catch(e=>{console.error(e.message);process.exit(1)});
