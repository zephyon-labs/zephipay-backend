// Audit-only SDK materialization. No publish, push, deployment or runtime activation.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const backend=resolve(fileURLToPath(new URL('..',import.meta.url)));
if(!process.argv[2])throw new Error('Provide the reviewed Protocol source directory.');
const protocol=resolve(process.argv[2]),vendor=join(backend,'vendor');mkdirSync(vendor,{recursive:true});
const manifest=JSON.parse(readFileSync(join(protocol,'package.json'),'utf8'));
if(manifest.name!=='zephyon-protocol'||manifest.version!=='0.4.0')throw new Error('Expected the 0.4.0 contract candidate.');
execFileSync('npm',['run','build'],{cwd:protocol,stdio:'inherit'});
const [pack]=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',vendor],{cwd:protocol,encoding:'utf8'}));
const roots=new Set(['package.json','README.md','docs/devnet-durable-submission-contract.md','docs/asset-economic-intent-v1.md']);
for(const {path} of pack.files){
 const pieces=path.split('/');
 if(!roots.has(path)&&!(pieces[0]==='dist'&&pieces.length>1&&pieces.every(x=>x&&x!=='.'&&x!=='..'&&!x.startsWith('.')&&!/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(x))&&/\.(js|js.map|d.ts|d.ts.map)$/.test(path)))throw new Error('Unexpected SDK package file: '+path);
}
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(join(dir,x.name)):[join(dir,x.name)]);}
const sourceFiles=[...walk(join(protocol,'src')),join(protocol,'package.json'),join(protocol,'tsconfig.json'),join(protocol,'tsconfig.build.json'),...['README.md','docs/devnet-durable-submission-contract.md','docs/asset-economic-intent-v1.md'].map(x=>join(protocol,x))].sort();
const hash=createHash('sha256');for(const file of sourceFiles){const data=readFileSync(file);hash.update(relative(protocol,file)+'\0'+data.length+'\0');hash.update(data);}
writeFileSync(join(vendor,'asset-intent-sdk-manifest.json'),JSON.stringify({status:'UNRELEASED_AUDIT_CANDIDATE',package:pack.filename,version:manifest.version,protocolBase:execFileSync('git',['rev-parse','HEAD'],{cwd:protocol,encoding:'utf8'}).trim(),sourceSha256:hash.digest('hex'),packageSha256:createHash('sha256').update(readFileSync(join(vendor,pack.filename))).digest('hex'),integrity:pack.integrity,files:pack.files.length},null,2)+'\n');
execFileSync('npm',['install','--save-exact','file:vendor/'+pack.filename,'--ignore-scripts'],{cwd:backend,stdio:'inherit'});
