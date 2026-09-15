import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import type { BridgeJournal } from './journal.js';
import type { journalDispatch } from './journal-fixtures.js';

type OwnerState = 'booting' | 'held' | 'released';
type OwnerReply = {
  requestId: number;
  state: OwnerState;
  pending: number;
};

/** Isolated test child only; IPC, not stdout, proves the requested stage finished. */
export function journalOwnerFixture(input: {
  journal: Parameters<typeof BridgeJournal.open>[0];
  dispatch: ReturnType<typeof journalDispatch>;
  effect: string;
  stage: 'effect_without_result' | 'result_committed';
}) {
  const child = spawn(
    process.execPath,
    [
      '--expose-gc',
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
      const { BridgeJournal } = await import(${JSON.stringify(new URL('./journal.ts', import.meta.url).href)});
      const { open, writeFile } = await import('node:fs/promises');
      const input = ${JSON.stringify(input)};
      let journal;
      let state = 'booting';
      // Deliberately not a readiness signal. The old once(stdout, 'data')
      // barrier cannot distinguish this from the committed-stage sentinel.
      process.stdout.write('fixture-booting\\n');
      process.on('message', async ({ requestId, action }) => {
        try {
          if (action === 'start') {
            if (state !== 'booting') throw new Error('FIXTURE_STATE_INVALID');
            journal = await BridgeJournal.open(input.journal);
            await journal.receive(input.dispatch);
            await journal.begin(input.dispatch.snapshot.binding.attempt.operationId);
            await writeFile(input.effect, 'effect happened');
            if (input.stage === 'result_committed') {
              await journal.outcome(input.dispatch.snapshot.binding.attempt.operationId,
                { status: 'succeeded', effects: 'applied', summary: 'result committed' });
            }
            state = 'held';
          } else if (action === 'release') {
            if (state !== 'held') throw new Error('FIXTURE_STATE_INVALID');
            await journal.close();
            state = 'released';
          } else if (action === 'gc') {
            globalThis.gc();
            globalThis.gc();
          } else if (action === 'drop-os-lock-for-control') {
            if (state !== 'held') throw new Error('FIXTURE_STATE_INVALID');
            // Deliberately forbidden production behavior: on POSIX, closing
            // another descriptor to the same inode drops this process's locks.
            // Only used to prove the diagnostic detects an actual live-owner
            // lock loss, never as recovery or as an explanation of the old run.
            const descriptor = await open(input.journal.directory + '/journal.sqlite', 'r');
            await descriptor.close();
          } else if (action !== 'probe') {
            throw new Error('FIXTURE_ACTION_INVALID');
          }
          // This closure deliberately owns the journal for the entire fixture
          // lifetime, as the running Core does; a live PID alone is not an owner.
          const pending = state === 'held' ? (await journal.pending()).length : 0;
          process.send({ requestId, state, pending });
        } catch {
          process.send({ requestId, failed: true });
        }
      });
    `,
    ],
    {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: fileURLToPath(
          new URL('../../../tsconfig.base.json', import.meta.url),
        ),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let state: OwnerState = 'booting';
  let sequence = 0;
  let spawnFailed = false;
  child.on('error', () => {
    spawnFailed = true;
  });
  child.stdout!.on('data', (data: Buffer) => {
    stdoutBytes += data.length;
  });
  child.stderr!.on('data', (data: Buffer) => {
    stderrBytes += data.length;
  });
  const evidence = () => ({
    pid: child.pid ?? null,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    connected: child.connected,
    spawnFailed,
    state,
    stdoutBytes,
    stderrBytes,
    node: process.version,
    sqlite: process.versions.sqlite ?? null,
    arch: process.arch,
    platform: process.platform,
  });
  const failure = (reason: string) =>
    new Error(
      `journal owner fixture ${JSON.stringify({ reason, ...evidence() })}`,
    );

  async function command(
    action: 'start' | 'probe' | 'release' | 'gc' | 'drop-os-lock-for-control',
  ) {
    if (
      !child.connected ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      throw failure('child-not-live');
    const requestId = ++sequence;
    return new Promise<OwnerReply>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
        child.off('error', onError);
      };
      const fail = (reason: string) => {
        cleanup();
        reject(failure(reason));
      };
      const onMessage = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const reply = value as Partial<OwnerReply> & { failed?: boolean };
        if (reply.requestId !== requestId) return;
        if (
          reply.failed ||
          !['booting', 'held', 'released'].includes(reply.state ?? '') ||
          !Number.isInteger(reply.pending)
        ) {
          fail('child-action-failed');
          return;
        }
        state = reply.state!;
        cleanup();
        resolve(reply as OwnerReply);
      };
      const onExit = () => fail('child-exited');
      const onError = () => fail('child-spawn-failed');
      const timer = setTimeout(() => fail('ipc-deadline'), 10_000);
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.once('error', onError);
      child.send({ requestId, action }, (error) => {
        if (error) fail('ipc-send-failed');
      });
    });
  }

  return {
    child,
    command,
    evidence,
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    },
  };
}
