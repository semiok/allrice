import { spawn } from 'node:child_process';
import { PersonVmError } from './contract.ts';

export type Command = {
  executable: string;
  args: readonly string[];
  env: Record<string, string>;
  input?: Uint8Array;
  signal: AbortSignal;
};
export type CommandRunner = (command: Command) => Promise<string>;

/** No shell, inherited secrets, detached child, raw stderr, or unjoined abort. */
export const runCommand: CommandRunner = async (command) => {
  command.signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      env: command.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const abort = () => {
      failed = true;
      child.kill('SIGKILL');
    };
    command.signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (data: Buffer) => {
      size += data.length;
      if (size > 4 * 1024 * 1024) abort();
      else chunks.push(data);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {
      failed = true;
    });
    child.on('error', () => {
      failed = true;
    });
    child.on('close', (code) => {
      command.signal.removeEventListener('abort', abort);
      if (failed || code !== 0 || command.signal.aborted) {
        reject(new PersonVmError('PROVIDER_FAILED'));
      } else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(command.input);
    if (command.signal.aborted) abort();
  });
};

export function hostEnvironment(home: string): Record<string, string> {
  return { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
}
