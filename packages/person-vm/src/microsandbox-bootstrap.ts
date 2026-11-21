import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { PersonVmError } from './contract.ts';
import type {
  PersonVmBootstrapScope,
  PersonVmGuestCommand,
  PersonVmJobExit,
  PersonVmManagedJob,
  PersonVmMemoryGuestPlan,
  PersonVmStartingScope,
} from './guest-bootstrap.ts';
import {
  nativeWebAuthArtifact,
  NATIVE_WEB_AUTH_READER,
  parseNativeWebAuth,
  type PersonVmNativeWebAuthRequest,
} from './native-web-auth.ts';

type NativeCommand = (
  args: string[],
  signal: AbortSignal,
  readNonzeroExit?: boolean,
) => Promise<string>;
function guestPath(path: string) {
  if (
    !isAbsolute(path) ||
    path === '/' ||
    path.includes('\0') ||
    posix.normalize(path) !== path
  )
    throw new PersonVmError('PROVIDER_FAILED');
}
function commandInput(command: PersonVmGuestCommand) {
  if (
    !command.executable ||
    [
      command.executable,
      ...command.args,
      ...Object.values(command.env ?? {}),
    ].some((v) => typeof v !== 'string' || v.includes('\0')) ||
    Object.keys(command.env ?? {}).some(
      (key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
    )
  )
    throw new PersonVmError('PROVIDER_FAILED');
  if (command.workdir) guestPath(command.workdir);
}

/** Pinned public cp/managed-job protocol. No DSH executor, shell interpolation,
 * private runtime DB, or assumption that terminating msb terminates its guest. */
export async function bootstrapMicrosandbox(input: {
  scope: PersonVmStartingScope;
  plan: PersonVmMemoryGuestPlan;
  stagingRoot: string;
  name: string;
  cleanupTimeoutMs: number;
  command: NativeCommand;
}): Promise<Pick<PersonVmBootstrapScope, 'launch' | 'readNativeWebAuth'>> {
  const { scope, name, command } = input;
  const plan = structuredClone(input.plan); // Trusted configuration snapshot, not guest authority.
  const paths = new Set<string>();
  for (const file of plan.files) {
    guestPath(file.path);
    if (
      paths.has(file.path) ||
      ![0o600, 0o700].includes(file.mode) ||
      typeof file.contents !== 'string'
    )
      throw new PersonVmError('PROVIDER_FAILED');
    paths.add(file.path);
  }
  guestPath(plan.launcher);
  commandInput(plan.initialize);
  commandInput({ executable: plan.launcher, args: [], env: plan.env });
  if (
    plan.initialize.executable !== 'node' ||
    !paths.has(plan.initialize.args[0]!) ||
    !plan.files.some(
      (file) => file.path === plan.launcher && file.mode === 0o700,
    )
  )
    throw new PersonVmError('PROVIDER_FAILED');

  async function spawn(
    commandSpec: PersonVmGuestCommand,
  ): Promise<PersonVmManagedJob> {
    commandInput(commandSpec);
    await scope.assertCurrent();
    const args = ['exec', name, '--detach', '--no-stdin', '--no-tty'];
    for (const [key, value] of Object.entries(commandSpec.env ?? {}))
      args.push('--env', `${key}=${value}`);
    if (commandSpec.workdir) args.push('--workdir', commandSpec.workdir);
    const jobId = (
      await command(
        [...args, '--', commandSpec.executable, ...commandSpec.args],
        scope.signal,
      )
    ).trim();
    // Native exec prints just its opaque ID. Lost/ambiguous admission is cleaned
    // by the service's whole-VM stop/status, never by discovering another job.
    if (!jobId || /[\s\0]/.test(jobId))
      throw new PersonVmError('PROVIDER_FAILED');
    async function wait(signal: AbortSignal): Promise<PersonVmJobExit> {
      const result: unknown = JSON.parse(
        await command(
          ['wait', name, '--job', jobId, '--format', 'json'],
          signal,
          true,
        ),
      );
      if (
        !result ||
        typeof result !== 'object' ||
        !('code' in result) ||
        !Number.isInteger(result.code) ||
        !('success' in result) ||
        result.success !== (result.code === 0) ||
        !('timed_out' in result) ||
        typeof result.timed_out !== 'boolean'
      )
        throw new PersonVmError('CLEANUP_INCOMPLETE');
      return Object.freeze({
        exitCode: result.code as number,
        timedOut: result.timed_out,
      });
    }
    const job: PersonVmManagedJob = Object.freeze({
      binding: scope.binding,
      jobId,
      wait,
      cancelAndWait: async (signal: AbortSignal) => {
        try {
          await command(['kill', name, '--job', jobId], signal);
        } catch {
          /* A completed job can refuse kill; only wait can certify it. */
        }
        return wait(signal);
      },
    });
    try {
      await scope.assertCurrent();
    } catch (error) {
      await job.cancelAndWait(AbortSignal.timeout(input.cleanupTimeoutMs));
      throw error;
    }
    return job;
  }
  async function run(commandSpec: PersonVmGuestCommand) {
    const job = await spawn(commandSpec);
    let result: PersonVmJobExit;
    try {
      result = await job.wait(scope.signal);
    } catch (error) {
      await job.cancelAndWait(AbortSignal.timeout(input.cleanupTimeoutMs));
      throw error;
    }
    if (result.exitCode !== 0 || result.timedOut)
      throw new PersonVmError('PROVIDER_FAILED');
    await scope.assertCurrent();
  }
  await scope.assertCurrent();
  const stage = await mkdtemp(join(input.stagingRoot, 'bootstrap-'));
  try {
    // cp preserves Unix permissions but doesn't create missing file parents.
    await run({
      executable: '/bin/mkdir',
      args: [
        '-p',
        '--',
        ...new Set(plan.files.map((file) => dirname(file.path))),
      ],
    });
    for (const [index, file] of plan.files.entries()) {
      await scope.assertCurrent();
      const hostFile = join(stage, String(index));
      await writeFile(hostFile, file.contents, { mode: file.mode, flag: 'wx' });
      await command(
        ['cp', hostFile, `${name}:${file.path}`, '--quiet'],
        scope.signal,
      );
      await scope.assertCurrent();
    }
    await run(plan.initialize);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return Object.freeze({
    readNativeWebAuth: async (request: PersonVmNativeWebAuthRequest) => {
      const { path, maxBytes } = nativeWebAuthArtifact(request);
      await scope.assertCurrent();
      const text = await command(
        [
          'exec',
          name,
          '--no-stdin',
          '--no-tty',
          '--timeout',
          `${Math.ceil(request.timeoutMs / 1000)}s`,
          '--',
          'node',
          '-e',
          NATIVE_WEB_AUTH_READER,
          path,
          String(maxBytes),
        ],
        // exec accepts whole seconds; keep the host's exact millisecond budget.
        AbortSignal.any([scope.signal, AbortSignal.timeout(request.timeoutMs)]),
      );
      await scope.assertCurrent();
      return parseNativeWebAuth(text, request);
    },
    launch: async (spec: PersonVmGuestCommand) => {
      commandInput(spec);
      if (
        Object.entries(plan.env).some(
          ([key, value]) => key in (spec.env ?? {}) && spec.env![key] !== value,
        )
      )
        throw new PersonVmError('PROVIDER_FAILED');
      return spawn({
        executable: plan.launcher,
        args: [spec.executable, ...spec.args],
        env: { ...spec.env, ...plan.env },
        ...(spec.workdir ? { workdir: spec.workdir } : {}),
      });
    },
  });
}
