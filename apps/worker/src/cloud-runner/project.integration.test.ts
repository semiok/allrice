import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type CloudProjectCommandSchema,
  CloudProjectRunResultSchema,
  cloudProjectResultMatchesPayload,
} from '@allrice/contracts';
import { projectToolReleases } from '@allrice/project-runtime';
import {
  CloudRunnerBackend,
  CloudProjectPreparationError,
  CloudRunnerError,
} from './backend.js';
import { cloudProjectFixture } from './project.fixture.js';

const suite =
  process.env.ALLRICE_RUN_PROJECT_CLOUD_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET166 PR3c exact project command — actual dedicated gVisor cloud',
  () => {
    const backend = new CloudRunnerBackend(),
      attempts: {
        id: string;
        command: ReturnType<typeof CloudProjectCommandSchema.parse>;
      }[] = [];
    const records: unknown[] = [];
    const evidence = process.env.ALLRICE_PROJECT_CLOUD_EVIDENCE;
    const save = () =>
      evidence
        ? writeFile(
            evidence,
            JSON.stringify(
              { backend: 'cloud-gvisor-v1', runtime: 'runsc', records },
              null,
              2,
            ) + '\n',
          )
        : Promise.resolve();
    beforeAll(async () => {
      // Reuse fixed verified public manager files; every real run rechecks bytes.
      const root = process.env.ALLRICE_PROJECT_TEST_MANAGER_ROOT;
      if (root) {
        await mkdir(join(backend.projectPreparation.root, 'tools'), {
          recursive: true,
          mode: 0o700,
        });
        for (const asset of [
          projectToolReleases.pnpm,
          projectToolReleases.uv.amd64,
        ]) {
          await copyFile(
            join(root, asset.fileName),
            join(backend.projectPreparation.root, 'tools', asset.fileName),
          );
        }
      }
    });
    afterEach(async () => {
      for (const a of attempts.splice(0)) {
        await backend.stop(a.id);
        await backend.cleanup(a.id, a.command);
      }
    });
    async function run(
      f: ReturnType<typeof cloudProjectFixture>,
      extra: Partial<Parameters<CloudRunnerBackend['execute']>[2]> = {},
      runner = backend,
    ) {
      const id = randomUUID();
      attempts.push({ id, command: f.command });
      let result;
      try {
        result = await runner.execute(f.command, [], {
          attemptId: id,
          projectScope: f.scope,
          deadlineAt: new Date(Date.now() + 60000).toISOString(),
          maintainLease: async () => true,
          ...extra,
        });
      } catch (error) {
        const c = await backend.inspect(id);
        const logs = c
          ? await backend.call(
              'GET',
              `/containers/${c.Id}/logs?stdout=1&stderr=1&follow=0`,
            )
          : null;
        records.push({
          attemptId: id,
          error: String(error),
          logs: logs?.toString('base64'),
        });
        await save();
        throw error;
      }
      records.push({
        attemptId: id,
        project: f.command.arguments.projectSource.project,
        result,
      });
      await save();
      return { id, result };
    }
    async function waitForCommand(containerId: string, text: string) {
      const until = Date.now() + 25000;
      const encoded = Buffer.from(text).toString('base64');
      while (Date.now() < until) {
        const logs = await backend.call(
          'GET',
          `/containers/${containerId}/logs?stdout=1&stderr=1&follow=0`,
        );
        if (logs.toString().includes(encoded)) return;
        await delay(100);
      }
      throw Error('actual tenant command did not start');
    }
    it.each(['pnpm', 'uv'] as const)(
      'installs %s cold, warm, offline and restores exact source on bounded work volumes',
      async (manager) => {
        const f = cloudProjectFixture(manager);
        for (const pass of ['cold', 'warm', 'offline'] as const) {
          f.command.arguments.projectPreparation.offline = pass === 'offline';
          const { id, result } = await run(f);
          expect(result.reason, result.output).toBe('completed');
          expect(result.exitCode, result.output).toBe(0);
          expect(result.output).toContain('dependency verification: 42');
          expect(
            cloudProjectResultMatchesPayload(
              f.command,
              CloudProjectRunResultSchema.parse(result),
            ),
          ).toBe(true);
          expect(result.projectPreparation?.archiveHits).toBe(
            pass === 'cold' ? 0 : 1,
          );
          const c = await backend.json<{
            HostConfig: {
              Runtime: string;
              NetworkMode: string;
              ReadonlyRootfs: boolean;
            };
            Mounts: { Type: string; Name: string; Destination: string }[];
          }>('GET', `/containers/${result.containerId}/json`);
          expect(c.HostConfig).toMatchObject({
            Runtime: 'runsc',
            NetworkMode: 'none',
            ReadonlyRootfs: true,
          });
          expect(c.Mounts.every((m) => m.Type === 'volume')).toBe(true);
          const work = await backend.json<{ Options: Record<string, string> }>(
            'GET',
            `/volumes/allrice-project-work-${id}`,
          );
          expect(work.Options).toMatchObject({
            type: 'tmpfs',
            device: 'tmpfs',
            o: 'size=128m,nosuid,nodev,mode=0755',
          });
          await backend.cleanup(id, f.command);
          await expect(
            backend.json('GET', `/volumes/allrice-project-work-${id}`),
          ).rejects.toThrow('CLOUD_DAEMON_404');
          expect(await backend.inspect(id)).toBeNull();
          attempts.splice(
            attempts.findIndex((a) => a.id === id),
            1,
          );
        }
      },
      210000,
    );
    it('offline cache miss rejects before create/start and does not fabricate a preparation result', async () => {
      const f = cloudProjectFixture();
      f.command.arguments.projectPreparation.offline = true;
      delete f.command.arguments.projectPreparation.packages[0]!.archivePath;
      const id = randomUUID();
      attempts.push({ id, command: f.command });
      await expect(
        backend.execute(f.command, [], {
          attemptId: id,
          projectScope: f.scope,
          deadlineAt: new Date(Date.now() + 60000).toISOString(),
          maintainLease: async () => true,
        }),
      ).rejects.toBeInstanceOf(CloudProjectPreparationError);
      expect(await backend.inspect(id)).toBeNull();
      await expect(
        backend.json('GET', `/volumes/allrice-project-work-${id}`),
      ).rejects.toThrow('CLOUD_DAEMON_404');
      records.push({ case: 'offline-miss', attemptId: id, notStarted: true });
      await save();
    }, 90000);
    it('preserves work/fence on a delayed create ACK and reclaims the eventual physical attempt without start', async () => {
      const f = cloudProjectFixture(),
        id = randomUUID();
      attempts.push({ id, command: f.command });
      class DelayedCreate extends CloudRunnerBackend {
        pending?: { path: string; body: unknown };
        starts = 0;
        override async call(
          method: string,
          path: string,
          body?: unknown,
        ): Promise<Buffer> {
          if (
            method === 'POST' &&
            path === `/containers/create?name=allrice-cloud-${id}`
          ) {
            this.pending = { path, body };
            throw new CloudRunnerError('CLOUD_DAEMON_TIMEOUT');
          }
          if (method === 'POST' && path.endsWith('/start')) this.starts++;
          return super.call(method, path, body);
        }
        async finishCreate() {
          return super.call('POST', this.pending!.path, this.pending!.body);
        }
      }
      const delayed = new DelayedCreate();
      await expect(
        delayed.execute(f.command, [], {
          attemptId: id,
          projectScope: f.scope,
          deadlineAt: new Date(Date.now() + 60000).toISOString(),
          maintainLease: async () => true,
        }),
      ).rejects.toThrow('CLOUD_DAEMON_TIMEOUT');
      expect(await delayed.inspect(id)).toBeNull();
      expect(
        (
          await delayed.json<{ Labels: Record<string, string> }>(
            'GET',
            `/volumes/allrice-project-work-${id}`,
          )
        ).Labels['xyz.bplabs.allrice.cloud.attempt'],
      ).toBe(id);
      expect(
        (
          await delayed.json<{ Config: { Labels: Record<string, string> } }>(
            'GET',
            '/containers/allrice-project-cache-fence/json',
          )
        ).Config.Labels['xyz.bplabs.allrice.project.fence-owner'],
      ).toBe(id);
      await delayed.finishCreate();
      expect((await delayed.inspect(id))?.State.Status).toBe('created');
      expect(delayed.starts).toBe(0);
      await delayed.cleanup(id, f.command);
      await expect(
        delayed.json('GET', `/volumes/allrice-project-work-${id}`),
      ).rejects.toThrow('CLOUD_DAEMON_404');
      records.push({
        case: 'delayed-create-fault-injection',
        attemptId: id,
        starts: delayed.starts,
        retainedUntilPhysicalAttempt: true,
        cleanup: true,
      });
      await save();
    }, 90000);
    it('reclaims the actual pre-created work volume after an explicit create rejection', async () => {
      const f = cloudProjectFixture(),
        id = randomUUID();
      attempts.push({ id, command: f.command });
      class RejectCreate extends CloudRunnerBackend {
        override async call(
          method: string,
          path: string,
          body?: unknown,
        ): Promise<Buffer> {
          if (
            method === 'POST' &&
            path === `/containers/create?name=allrice-cloud-${id}`
          )
            throw new CloudRunnerError('CLOUD_DAEMON_400');
          return super.call(method, path, body);
        }
      }
      const rejected = new RejectCreate();
      await expect(
        rejected.execute(f.command, [], {
          attemptId: id,
          projectScope: f.scope,
          deadlineAt: new Date(Date.now() + 60000).toISOString(),
          maintainLease: async () => true,
        }),
      ).rejects.toBeInstanceOf(CloudProjectPreparationError);
      expect(await rejected.inspect(id)).toBeNull();
      await rejected.cleanup(id, f.command);
      await expect(
        rejected.json('GET', `/volumes/allrice-project-work-${id}`),
      ).rejects.toThrow('CLOUD_DAEMON_404');
      records.push({
        case: 'explicit-create-rejection',
        attemptId: id,
        notStarted: true,
        namedWorkReclaimed: true,
      });
      await save();
    }, 90000);
    it('serializes cache mutation across independent Workers and isolates owner cache identities', async () => {
      const first = cloudProjectFixture(),
        second = cloudProjectFixture();
      first.command.arguments.args = [
        '-e',
        "console.log('fence-command-started');setTimeout(()=>{},3000)",
      ];
      first.command.arguments.limits.timeoutMs = 60000;
      second.command.arguments.limits.timeoutMs = 60000;
      expect(first.command.arguments.projectSource.cacheKey).not.toBe(
        second.command.arguments.projectSource.cacheKey,
      );
      let next: ReturnType<typeof run> | undefined,
        notRunningAtSecondCreate = false;
      const one = await run(first, {
        observe: async (e) => {
          if (e.stage === 'executing') {
            await waitForCommand(e.containerId!, 'fence-command-started\n');
            next = run(
              second,
              {
                onCreated: async () => {
                  notRunningAtSecondCreate =
                    (
                      await backend.json<{ State: { Running: boolean } }>(
                        'GET',
                        `/containers/${e.containerId!}/json`,
                      )
                    ).State.Running === false;
                },
              },
              new CloudRunnerBackend(),
            );
          }
        },
      });
      expect(next).toBeDefined();
      const two = await next!;
      expect(one.result.reason).toBe('completed');
      expect(two.result.reason).toBe('completed');
      expect(notRunningAtSecondCreate).toBe(true);
      records.push({
        case: 'cross-worker-fence-owner-isolation',
        attempts: [one.id, two.id],
        notRunningAtSecondCreate,
      });
      await save();
    }, 120000);
    it('cancels a running command and confirms physical stopped/source proof before cleanup', async () => {
      const f = cloudProjectFixture();
      f.command.arguments.args = [
        '-e',
        "console.log('command-running');setInterval(()=>{},1000)",
      ];
      const abort = new AbortController();
      const { id, result } = await run(f, {
        signal: abort.signal,
        observe: async (e) => {
          if (e.stage === 'executing') {
            await waitForCommand(e.containerId!, 'command-running\n');
            abort.abort();
          }
        },
      });
      expect(result.reason).toBe('canceled');
      expect(result.output).toContain('command-running');
      expect(result.projectPreparation?.installation).toBe('succeeded');
      expect(result.stopped).toBe(true);
      expect(result.projectPreparation?.savedSource?.restoredDigest).toBe(
        f.command.arguments.projectPreparation.sourceDigest,
      );
      expect((await backend.inspect(id))?.State.Running).toBe(false);
    }, 90000);
    it('stops after lease loss, preserving evidence without success or a new attempt', async () => {
      const f = cloudProjectFixture();
      f.command.arguments.args = [
        '-e',
        "console.log('lease-command-started');setInterval(()=>{},1000)",
      ];
      let valid = true;
      const { id, result } = await run(f, {
        maintainLease: async () => valid,
        observe: async (e) => {
          if (e.stage === 'executing') {
            await waitForCommand(e.containerId!, 'lease-command-started\n');
            valid = false;
          }
        },
      });
      expect(result.reason).toBe('canceled');
      expect(result.stopped).toBe(true);
      expect((await backend.inspect(id))?.State.Running).toBe(false);
    }, 90000);
  },
);
