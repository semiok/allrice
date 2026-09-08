import { projectDiagnosticProgram } from './project-diagnostics.js';

/** Trusted PID 1. This source is sent only to an explicitly configured local VM.
 * Project code runs in a separate UID and cannot replace/stop its deadline timer.
 * Exiting PID 1 destroys the PID namespace, including setsid/reparented children.
 */
export const localCommandSupervisor = String.raw`
import { spawn } from 'node:child_process';
import { mkdir, writeFile, chown, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { constants } from 'node:os';

const chunks = Number(process.env.ALLRICE_INPUT_PARTS);
if (!Number.isInteger(chunks) || chunks < 1 || chunks > 32) process.exit(125);
const text = Array.from({length: chunks}, (_, i) => process.env['ALLRICE_INPUT_' + i] || '').join('');
const bundle = JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
let finished = false, size = 0, frames = 0;
const exitCode = (code, signal) => Number.isInteger(code) ? code : signal && constants.signals[signal] ? 128 + constants.signals[signal] : 125;
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const end = (reason, code) => {
  if (finished) return;
  finished = true;
  emit({type:'exit', reason, code});
  // Explicit exit also kills detached descendants; do not wait for child pipes.
  process.stdout.write('', () => process.exit(code));
  setTimeout(() => process.exit(code), 100).unref();
};
const timer = setTimeout(() => end('timeout', 124), Math.max(0, Math.min(bundle.command.limits.timeoutMs,
  bundle.deadlineUnixMs === undefined ? Infinity : bundle.deadlineUnixMs - Date.now())));
try {
  const directories = new Set(['/workspace']);
  for (const file of bundle.files) {
    if (!file.path || file.path.startsWith('/') || file.path.split('/').some(p => !p || p === '.' || p === '..')) throw Error('path');
    const target = '/workspace/' + file.path;
    await mkdir(dirname(target), {recursive:true, mode:0o755});
    await writeFile(target, Buffer.from(file.content, 'base64'), {flag:'wx', mode:0o600});
    await chown(target, 1000, 1000);
    let dir = dirname(target);
    while (dir.startsWith('/workspace')) { directories.add(dir); dir = dirname(dir); }
  }
  // PID 1 deliberately lacks DAC_OVERRIDE. Transfer directories only AFTER all
  // inputs were staged, otherwise creating the second file fails with EACCES.
  for (const dir of directories) await chown(dir,1000,1000);
  const oomCount = async () => Number((await readFile('/sys/fs/cgroup/memory.events','utf8')).match(/^oom_kill (\d+)$/m)?.[1] || 0);
  const beforeOom = await oomCount();
  for(const name of ['user','global']) await writeFile('/tmp/allrice-npm-'+name+'.conf','',{flag:'wx',mode:0o444});
  const commands = [];
  const npmFlags = ['--offline','--cache=/tmp/npm-cache','--userconfig=/tmp/allrice-npm-user.conf','--globalconfig=/tmp/allrice-npm-global.conf','--registry=https://registry.npmjs.org','--no-audit','--no-fund'];
  if(bundle.command.dependencies) {
    await mkdir('/tmp/allrice-archives',{mode:0o755});
    for(let i=0;i<bundle.archives.length;i++) {
      const path='/tmp/allrice-archives/'+i+'.tgz';
      await writeFile(path,Buffer.from(bundle.archives[i],'base64'),{flag:'wx',mode:0o444});
      commands.push(['/usr/local/bin/npm',['cache','add',path,'--ignore-scripts',...npmFlags]]);
    }
    commands.push(['/usr/local/bin/npm',['ci','--foreground-scripts',bundle.command.dependencies.scripts==='disabled'?'--ignore-scripts':'--ignore-scripts=false',...npmFlags]]);
  }
  const args = bundle.command.diagnostics
    ? ['--input-type=module','--eval', ${JSON.stringify(projectDiagnosticProgram)}, JSON.stringify(bundle.command.diagnostics)]
    : bundle.command.args;
  commands.push([bundle.command.executable,args]);
  const runChild = (executable,args) => new Promise(resolve => {
  const child = spawn(executable, args, {
    cwd: bundle.command.path === '.' ? '/workspace' : '/workspace/' + bundle.command.path,
    uid:1000, gid:1000, detached:false, stdio:['ignore','pipe','pipe'],
    env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp',LANG:'C.UTF-8',CI:'1',
      npm_config_cache:'/tmp/npm-cache',npm_config_update_notifier:'false',npm_config_audit:'false',npm_config_fund:'false',npm_config_userconfig:'/tmp/allrice-npm-user.conf',npm_config_globalconfig:'/tmp/allrice-npm-global.conf'},
  });
  for (const stream of ['stdout','stderr']) child[stream].on('data', (bytes) => {
    const available = Math.max(0, bundle.command.limits.outputBytes - size);
    const kept = bytes.subarray(0, available);
    size += bytes.length;
    if (kept.length && frames < 254) { frames++; emit({type:stream,data:kept.toString('base64')}); }
    if (size > bundle.command.limits.outputBytes || frames >= 254) end('output_limit', 122);
  });
  child.once('error', () => end('supervisor_failed',125));
  let drainTimer;
  child.once('exit', (code, signal) => {
    // Normal close drains both pipes. Detached descendants can hold pipes open;
    // never wait indefinitely for them, and disclose the bounded-drain fallback.
    drainTimer = setTimeout(() => end('output_limit', exitCode(code,signal)), 250);
  });
  child.once('close', async (code, signal) => {
    clearTimeout(drainTimer);
    try { resolve({reason:(await oomCount()) > beforeOom ? 'memory_limit' : 'exited',code:exitCode(code,signal)}); }
    catch { end('supervisor_failed',125); }
  });
  });
  for(let i=0;i<commands.length;i++) {
    if(finished) break;
    const result=await runChild(...commands[i]);
    if(result.code!==0 || i===commands.length-1) {clearTimeout(timer);end(result.reason,result.code);break;}
  }
} catch {
  clearTimeout(timer);
  end('supervisor_failed',125);
}
`;
