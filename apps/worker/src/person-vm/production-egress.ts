import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { join, posix } from 'node:path';
import { EgressError, type EgressProvisioner } from '@allrice/egress-gateway';
import type { PersonVmBinding, PersonVmRuntimePort } from '@allrice/person-vm';
import { createVmMemoryGuestPlan } from '@allrice/vm-memory/guest-plan';
import { z } from 'zod';
import type { readVerifiedProductionPersonVmInputs } from './production-artifacts.js';

type Loaded = Awaited<ReturnType<typeof readVerifiedProductionPersonVmInputs>>;
type Entry = {
  key: string;
  binding: PersonVmBinding;
  abort: AbortController;
  pending: Set<Promise<unknown>>;
  path: string;
  created: boolean;
  identity?: Stats;
  contents: Buffer;
  ready: boolean;
  retirement?: Promise<void>;
};
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const keyOf = (b: PersonVmBinding) =>
  JSON.stringify([
    b.vmId,
    b.personId,
    b.organizationId,
    b.instanceId,
    b.leaseEpoch,
  ]);
const code = (error: unknown, value: string) =>
  error instanceof Error && 'code' in error && error.code === value;
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const unavailable = () => new EgressError('UNAVAILABLE');
const accessSchema = z.object({
  access: z.object({ origin: z.string(), capability: z.string() }),
});
async function finish<T>(file: FileHandle, work: () => Promise<T>) {
  const result = await work().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const cleanup = await file.close().then(
    () => undefined,
    (error: unknown) => ({ error }),
  );
  if ('error' in result)
    throw cleanup
      ? new AggregateError([result.error, cleanup.error], 'EGRESS_FILE_FAILED')
      : result.error;
  if (cleanup) throw cleanup.error;
  return result.value;
}

/** Private config staging and public guest-plan consumption, not route authority or an installed Host. */
export function createProductionEgressInstallation(
  loaded: Loaded,
  lifetime: AbortSignal,
) {
  const config = loaded.configuration.egress;
  if (!config) throw unavailable();
  const closed = new AbortController(),
    pending = new Set<Promise<unknown>>(),
    entries = new Map<string, Entry>();
  let closing: Promise<void> | undefined;
  function check(signal: AbortSignal) {
    lifetime.throwIfAborted();
    closed.signal.throwIfAborted();
    signal.throwIfAborted();
  }
  function own<T>(
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
    entry?: Entry,
  ) {
    const combined = AbortSignal.any([
      signal,
      lifetime,
      closed.signal,
      ...(entry ? [entry.abort.signal] : []),
    ]);
    const task = Promise.resolve().then(() => work(combined));
    pending.add(task);
    entry?.pending.add(task);
    const done = () => {
      pending.delete(task);
      entry?.pending.delete(task);
    };
    void task.then(done, done);
    return task;
  }
  async function erase(entry: Entry) {
    if (entry.created) {
      if (!entry.identity) throw unavailable();
      const stat = await lstat(entry.path).catch((error) => {
        if (!code(error, 'ENOENT')) throw error;
      });
      if (stat) {
        if (!same(stat, entry.identity) || !stat.isFile()) throw unavailable();
        await unlink(entry.path);
      }
    }
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
  }
  function retire(entry: Entry) {
    entry.ready = false;
    entry.abort.abort(unavailable());
    return (entry.retirement ??= (async () => {
      await Promise.allSettled([...entry.pending]);
      await erase(entry);
    })());
  }
  const provisioner: EgressProvisioner = {
    async endpoint(_vmId, ports, signal) {
      check(signal);
      if (
        ports.length > 1 ||
        ports.some(
          (port) => !Number.isInteger(port) || port < 1 || port > 65535,
        )
      )
        throw new EgressError('POLICY_INVALID');
      const port = ports[0] ?? 0;
      const host = config.guestGatewayAddress.includes(':')
        ? `[${config.guestGatewayAddress}]`
        : config.guestGatewayAddress;
      return {
        host: config.listenAddress,
        port,
        guestOrigin: new URL(`http://${host}:${port}`).origin,
      };
    },
    async install(binding, mount, access, signal) {
      check(signal);
      const key = keyOf(binding);
      if (entries.has(key)) throw unavailable();
      const entry: Entry = {
        key,
        binding: Object.freeze({ ...binding }),
        abort: new AbortController(),
        pending: new Set(),
        path: '',
        created: false,
        ready: false,
        contents: Buffer.from(
          JSON.stringify({
            binding,
            release: loaded.applicationBuild,
            access: { ...access },
          }) + '\n',
        ),
      };
      entries.set(key, entry);
      return own(
        signal,
        async (signal) => {
          try {
            signal.throwIfAborted();
            if (!(await lstat(mount)).isDirectory()) throw unavailable();
            const directory = join(await realpath(mount), '.allrice-egress');
            await mkdir(directory, { mode: 0o700 }).catch((error) => {
              if (!code(error, 'EEXIST')) throw error;
            });
            const stat = await lstat(directory);
            if (
              !stat.isDirectory() ||
              stat.uid !== process.getuid?.() ||
              (stat.mode & 0o777) !== 0o700 ||
              (await realpath(directory)) !== directory
            )
              throw unavailable();
            signal.throwIfAborted();
            entry.path = join(directory, `${hash(key)}.json`);
            const file = await open(
              entry.path,
              constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW,
              0o600,
            );
            entry.created = true;
            await finish(file, async () => {
              entry.identity = await file.stat();
              if (
                !entry.identity.isFile() ||
                entry.identity.uid !== process.getuid?.() ||
                (entry.identity.mode & 0o777) !== 0o600
              )
                throw unavailable();
              await file.writeFile(entry.contents);
            });
            signal.throwIfAborted();
            entry.ready = true;
          } catch (error) {
            try {
              await erase(entry);
            } catch (cleanup) {
              throw new AggregateError(
                [error, cleanup],
                'EGRESS_INSTALL_FAILED',
              );
            }
            throw error;
          }
        },
        entry,
      );
    },
    async remove(binding, signal) {
      const entry = entries.get(keyOf(binding));
      if (!entry) return;
      const task = retire(entry);
      pending.add(task);
      try {
        await task;
      } finally {
        pending.delete(task);
      }
      signal.throwIfAborted();
    },
  };
  const memoryGuestPlan: PersonVmRuntimePort['memoryGuestPlan'] = async (
    binding,
    signal,
  ) => {
    check(signal);
    const entry = entries.get(keyOf(binding));
    if (!entry?.ready) throw unavailable();
    return own(
      signal,
      async (signal) => {
        signal.throwIfAborted();
        const file = await open(
          entry.path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const contents = await finish(file, async () => {
          const stat = await file.stat();
          if (
            !entry.identity ||
            !stat.isFile() ||
            !same(stat, entry.identity) ||
            stat.uid !== process.getuid?.() ||
            (stat.mode & 0o777) !== 0o600 ||
            stat.size !== entry.contents.length
          )
            throw unavailable();
          return file.readFile();
        });
        if (
          !contents.equals(entry.contents) ||
          hash(contents) !== hash(entry.contents)
        )
          throw unavailable();
        const access = accessSchema.parse(
          JSON.parse(contents.toString('utf8')),
        ).access;
        const url = new URL(access.origin);
        if (
          url.origin !== access.origin ||
          url.protocol !== 'http:' ||
          !/^[A-Za-z0-9_-]+$/.test(access.capability)
        )
          throw unavailable();
        const plan = await createVmMemoryGuestPlan({
          ...loaded.configuration.memory,
        });
        const directory = posix.join(
          loaded.configuration.memory.persistentDirectory,
          '.allrice-egress',
          hash(entry.key),
        );
        const hostname = url.hostname.startsWith('[')
          ? url.hostname.slice(1, -1)
          : url.hostname;
        const contentsByName = {
          npmrc: `registry=${access.origin}/npm/\n//${url.host}/:_authToken=${access.capability}\n`,
          netrc: `machine ${hostname} login egress password ${access.capability}\n`,
          'pip.conf': `[global]\nindex-url=${access.origin}/python/simple/\ntrusted-host=${hostname}\n`,
        };
        const files = Object.entries(contentsByName).map(
          ([name, contents]) => ({
            path: posix.join(directory, name),
            contents,
            mode: 0o600,
          }),
        );
        const env = {
          npm_config_userconfig: posix.join(directory, 'npmrc'),
          NETRC: posix.join(directory, 'netrc'),
          PIP_CONFIG_FILE: posix.join(directory, 'pip.conf'),
        };
        if (
          files.some((file) =>
            plan.files.some((old) => old.path === file.path),
          ) ||
          Object.entries(env).some(
            ([key, value]) => key in plan.env && plan.env[key] !== value,
          )
        )
          throw unavailable();
        signal.throwIfAborted();
        if (!entry.ready || entries.get(entry.key) !== entry)
          throw unavailable();
        return {
          ...plan,
          files: [...plan.files, ...files],
          env: { ...plan.env, ...env },
        };
      },
      entry,
    );
  };
  function close() {
    closed.abort(unavailable());
    return (closing ??= (async () => {
      await Promise.allSettled([...pending]);
      const results = await Promise.allSettled(
        [...entries.values()].map(retire),
      );
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, 'EGRESS_CLEANUP_INCOMPLETE');
    })());
  }
  return Object.freeze({ provisioner, memoryGuestPlan, close });
}
