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
  for (const file of bundle.files) {
    if (!file.path || file.path.startsWith('/') || file.path.split('/').some(p => !p || p === '.' || p === '..')) throw Error('path');
    const target = '/workspace/' + file.path;
    await mkdir(dirname(target), {recursive:true, mode:0o755});
    await writeFile(target, Buffer.from(file.content, 'base64'), {flag:'wx', mode:0o600});
    await chown(target, 1000, 1000);
    let dir = dirname(target);
    while (dir.startsWith('/workspace')) { await chown(dir,1000,1000); dir = dirname(dir); }
  }
  const oomCount = async () => Number((await readFile('/sys/fs/cgroup/memory.events','utf8')).match(/^oom_kill (\d+)$/m)?.[1] || 0);
  const beforeOom = await oomCount();
  const child = spawn(bundle.command.executable, bundle.command.args, {
    cwd: bundle.command.path === '.' ? '/workspace' : '/workspace/' + bundle.command.path,
    uid:1000, gid:1000, detached:false, stdio:['ignore','pipe','pipe'],
    env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp',LANG:'C.UTF-8',CI:'1',
      npm_config_cache:'/tmp/npm-cache',npm_config_update_notifier:'false',npm_config_audit:'false',npm_config_fund:'false'},
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
    clearTimeout(timer); clearTimeout(drainTimer);
    try { end((await oomCount()) > beforeOom ? 'memory_limit' : 'exited', exitCode(code,signal)); }
    catch { end('supervisor_failed',125); }
  });
} catch {
  clearTimeout(timer);
  end('supervisor_failed',125);
}
`;
