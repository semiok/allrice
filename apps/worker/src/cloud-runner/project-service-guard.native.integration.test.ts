import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { cloudToolchainImageV1 } from '@allrice/contracts';
import { CloudRunnerBackend } from './backend.js';
import { openCloudProjectServiceGuard } from './project-service-guard.js';
const suite =
  process.env.ALLRICE_RUN_CLOUD_PROJECT_SERVICE_NATIVE === '1'
    ? describe.sequential
    : describe.skip;
suite('owned runsc VM physical project guard', () => {
  for (const service of [true, false])
    it(
      service
        ? 'stops a SIGSTOP project when its root-owned physical lease is lost'
        : 'retains the original 65-second ceiling for ordinary commands',
      async () => {
        const backend = new CloudRunnerBackend(),
          attempt = randomUUID(),
          hard = new Date(Date.now() + 300000).toISOString();
        let id: string | undefined,
          guard:
            | Awaited<ReturnType<typeof openCloudProjectServiceGuard>>
            | undefined;
        const proof = {
          passed: false,
          service,
          attempt,
          ceilingRetained: !service,
          guardKillsSuspendedProcess: service,
          physicalCleanup: false,
          elapsedMs: 0,
        };
        // This fixture checks the independent root guard, not saved-source
        // admission. Read only its exact Docker ID; it has no project volumes.
        const inspect = async () =>
          id
            ? backend
                .json<{ State: { Running: boolean } }>(
                  'GET',
                  `/containers/${id}/json`,
                )
                .catch((error) => {
                  if (error.message === 'CLOUD_DAEMON_404') return null;
                  throw error;
                })
            : null;
        try {
          await backend.preflight(undefined, service);
          const labels = {
            'xyz.bplabs.allrice.backend': 'cloud-gvisor-v1',
            'xyz.bplabs.allrice.cloud.attempt': attempt,
            'xyz.bplabs.allrice.cloud.deadline': String(Date.parse(hard)),
            ...(service
              ? {
                  'xyz.bplabs.allrice.cloud.kind': 'project',
                  'xyz.bplabs.allrice.cloud.service': 'project-v1',
                  'xyz.bplabs.allrice.cloud.service-id': randomUUID(),
                }
              : {}),
          };
          const created = await backend.json<{ Id: string }>(
            'POST',
            '/containers/create?name=allrice-cloud-' + attempt,
            {
              Image: cloudToolchainImageV1,
              Entrypoint: ['/usr/local/bin/node'],
              Cmd: ['-e', 'setInterval(()=>{},1000)'],
              User: '0:0',
              Labels: labels,
              HostConfig: {
                Runtime: 'runsc',
                NetworkMode: 'none',
                ReadonlyRootfs: true,
                CapDrop: ['ALL'],
                CapAdd: [
                  'CHOWN',
                  'FOWNER',
                  'DAC_OVERRIDE',
                  'SETUID',
                  'SETGID',
                  'KILL',
                ],
                Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=32m,mode=1777' },
                SecurityOpt: ['no-new-privileges'],
                Memory: 512 * 1024 * 1024,
                Ulimits: [
                  { Name: 'nofile', Soft: 128, Hard: 128 },
                  { Name: 'core', Soft: 0, Hard: 0 },
                ],
                // runsc's own threads count against Docker's cgroup limit.
                // Use the actual admitted cloud limit, not an invalid fixture.
                PidsLimit: 64,
                RestartPolicy: { Name: 'no' },
              },
            },
          );
          id = created.Id;
          if (service)
            guard = await openCloudProjectServiceGuard(attempt, hard);
          await backend
            .call('POST', `/containers/${id}/start`)
            .catch((error) => {
              if (service) throw error;
            });
          if (service) {
            await guard!.renew(Date.now() + 5000);
            expect((await inspect())?.State.Running).toBe(true);
            await backend.call('POST', `/containers/${id}/kill?signal=STOP`);
          }
          const lostAt = Date.now();
          guard?.close();
          while ((await inspect())?.State.Running) {
            if (Date.now() - lostAt > 8000)
              throw Error('physical watchdog failed to stop owned fixture');
            await delay(100);
          }
          proof.elapsedMs = Date.now() - lostAt;
          expect(proof.elapsedMs).toBeLessThan(8000);
          await backend.call('DELETE', `/containers/${id}?v=true`);
          expect(await inspect()).toBeNull();
          id = undefined;
          proof.physicalCleanup = true;
          proof.passed = true;
        } finally {
          guard?.close();
          if (id) {
            await backend
              .call('DELETE', `/containers/${id}?force=true&v=true`)
              .catch(() => undefined);
          }
          if (process.env.ALLRICE_CLOUD_GUARD_EVIDENCE)
            await writeFile(
              process.env.ALLRICE_CLOUD_GUARD_EVIDENCE +
                (service ? '-service.json' : '-finite.json'),
              JSON.stringify(proof, null, 2) + '\n',
              { mode: 0o600 },
            );
        }
      },
      30000,
    );
});
