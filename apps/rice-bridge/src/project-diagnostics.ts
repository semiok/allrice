import {
  RuntimeProjectDiagnosticsSchema,
  type RuntimeLocalCommand,
} from '@allrice/contracts';

/** Trusted probe, run as the unprivileged project UID in the same fixed image.
 * Does not import project code, run version commands through PATH, or echo JSON.
 * Only the explicitly approved manifest copy exists in /workspace.
 */
export const projectDiagnosticProgram = String.raw`
import {readFile, access} from 'node:fs/promises';
const expected = JSON.parse(process.argv[1]);
const object = x => x && typeof x==='object' && !Array.isArray(x);
let pkg, project='available';
try { pkg=JSON.parse(await readFile('package.json','utf8')); if(!object(pkg)) throw Error(); }
catch(e) { project=e.code==='ENOENT'?'manifest_missing':'manifest_invalid'; }
let npm=null;
try { const p=JSON.parse(await readFile('/usr/local/lib/node_modules/npm/package.json','utf8')); if(/^\d+\.\d+\.\d+$/.test(p.version)) npm=p.version; } catch {}
const locks=[];
for(const name of ['package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock']) {
  try { await access(name); locks.push(name); } catch {}
}
let pm = typeof pkg?.packageManager==='string' ? /^(npm|pnpm|yarn)@/.exec(pkg.packageManager)?.[1] : null;
pm ??= locks.length===1 ? ({'pnpm-lock.yaml':'pnpm','yarn.lock':'yarn'}[locks[0]] || 'npm') : 'unknown';
let dependencies='unknown';
if(project==='available') {
  const groups=['dependencies','devDependencies','optionalDependencies'];
  if(groups.every(k => pkg[k]===undefined || object(pkg[k]))) dependencies=groups.some(k => Object.keys(pkg[k] || {}).length) ? 'not_prepared':'none_declared';
}
// An engine expression is a declaration, not proof that it was satisfied.
const rawEngine=pkg?.engines?.node;
const nodeEngine=typeof rawEngine==='string' && rawEngine.length<=100 && /^[v\d\s.*xX<>=|^~+-]+$/.test(rawEngine) ? rawEngine : null;
console.log(JSON.stringify({version:1,target:'local_linux_isolated_copy',hostToolchain:'not_inspected',
  platform:process.platform,architecture:process.arch,directory:process.cwd(),
  node:{path:'/usr/local/bin/node',version:process.version,status:expected.expectedNodeMajor && Number(process.versions.node.split('.')[0])!==expected.expectedNodeMajor?'version_mismatch':'available'},
  npm:{path:'/usr/local/bin/npm',version:npm,status:!npm?'not_installed':expected.expectedNpmMajor && Number(npm.split('.')[0])!==expected.expectedNpmMajor?'version_mismatch':'available'},
  project,packageManager:pm,lockfile:locks.length>1?'multiple':locks[0]||'missing',dependencies,nodeEngine,
  engineStatus:rawEngine===undefined?'not_declared':'requires_review',network:'disabled',installedOrRepaired:false}));
`;

export function diagnosticEvidence(
  command: RuntimeLocalCommand,
  stdout: string,
  exitCode: number,
  reason: string,
) {
  if (!command.arguments.diagnostics || exitCode !== 0 || reason !== 'exited')
    return {};
  try {
    return {
      diagnostics: RuntimeProjectDiagnosticsSchema.parse(JSON.parse(stdout)),
    };
  } catch {
    return {};
  } // Incomplete output never becomes fabricated diagnostic evidence.
}
