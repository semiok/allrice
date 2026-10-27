import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { experiencePolicySchedule } from '@allrice/contracts';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { authorizeFixturePlatformAdministrator } from '../../../packages/database/src/platform-authority.fixture.ts';
import { seedExperienceCalendarRule } from '../../../packages/database/src/experience-native.fixture.ts';
import {
  readExperiencePolicy,
  updateExperiencePolicy,
} from '../../../packages/database/src/experience-consolidation.ts';
import { createChatSession } from '../../../packages/database/src/workspace/service.ts';
import {
  createRecurringTask,
  initializeNativeRecurringPartition,
} from '../../../packages/database/src/native-schedule-recurring-product.ts';
import * as client from '../../../packages/database/src/core/client.ts';
import { nextScheduleAt } from '../../../packages/database/src/execution/automation.ts';
import { parseNativeScheduleControlReference } from '../src/native-schedule-once-loader.ts';

const run = promisify(execFile);
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' &&
  process.env.ALLRICE_RUN_NATIVE_CALENDAR_HOST === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'production mixed public Host calendar cycle, actual clock and zero model calls',
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let seeded: Awaited<ReturnType<typeof seedExperienceCalendarRule>>;
    let fixedId: string;
    let acceptancePassed = false;
    beforeAll(async () => {
      if (
        process.env.DATABASE_URL ||
        process.env.ALLRICE_TEST_DATABASE_URL !==
          'postgres://a123@127.0.0.1:5432/allrice_b2'
      )
        throw Error('actual_host_requires_authorized_allrice_b2_fixture');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
      vi.stubEnv('ALLRICE_NATIVE_CALENDAR_ENABLED', '1');
      vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '1');
      const reference = parseNativeScheduleControlReference(
        JSON.parse(process.env.ALLRICE_NATIVE_RECURRING_REFERENCE ?? 'null'),
      );
      expect(reference.profileId).toBe('allrice-recurring-control-v1');
      expect(reference.artifactId).toBe(
        process.env.ALLRICE_DSH_NATIVE_ARTIFACT_ID,
      );
      expect(
        isAbsolute(
          process.env.ALLRICE_NATIVE_CALENDAR_HOST_ARTIFACT_ROOT ?? '',
        ),
      ).toBe(true);
      expect(await readdir(reference.stateRoot)).toEqual([]);
      f = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
        personalProfile: 'writable',
      });
      const [scope] =
        await f.db`select current_schema() schema,current_database() database`;
      expect(scope?.database).toBe('allrice_b2');
      expect(scope?.schema).toBe(f.schema);
      expect(f.schema).toMatch(/^p25_[a-f0-9]{32}$/);
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      await authorizeFixturePlatformAdministrator(f.db, f.ownerId);
      const previous = await readExperiencePolicy(f.organizationId);
      await updateExperiencePolicy(f.context, f.organizationId, {
        frequency: 'monthly',
        timezone: 'America/New_York',
        time: '02:30',
        weekday: 1,
        monthDay: 31,
        expectedRevision: previous.revision,
        validationMode: 'off',
        adoptionMode: 'off',
      });
      seeded = await seedExperienceCalendarRule(f, 'empty');
      // Preserve a genuine missed business target under the saved monthly
      // policy. The shared SQL helper's arbitrary old timestamp is unsuitable
      // as proof of a real monthly clock. No native Task/receipt exists yet.
      const schedule = experiencePolicySchedule(
        await readExperiencePolicy(f.organizationId),
      );
      expect(schedule).toEqual({
        frequency: 'monthly',
        timezone: 'America/New_York',
        time: '02:30',
        weekday: 1,
        monthDay: 31,
      });
      const P = nextScheduleAt(
        schedule,
        new Date(Date.now() - 45 * 86_400_000),
      );
      expect(P.getTime()).toBeLessThan(Date.now());
      expect(
        nextScheduleAt(schedule, new Date(P.getTime() - 1)).toISOString(),
      ).toBe(P.toISOString());
      const [saved] = await f.db<{ next_run_at: Date }[]>`
        update allrice_automations set next_run_at=${P}
        where id=${seeded.automationId} and organization_id=${f.organizationId}
        and workspace_id=${f.workspaceId} and owner_id=${f.ownerId}
        and clock_owner='legacy' and status='enabled'
        returning next_run_at`;
      expect(saved?.next_run_at.toISOString()).toBe(P.toISOString());
      seeded.P = P;
      await initializeNativeRecurringPartition(reference);
      const chat = await createChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: 'Isolated fixed coexistence',
      });
      fixedId = (
        await createRecurringTask(f.context, chat.id, {
          clientRequestId: randomUUID(),
          name: 'Fixed real public clock witness',
          prompt:
            'Record this isolated scheduled receipt; no paid executor is started.',
          rule: { kind: 'every', seconds: 60 },
        })
      ).id;
    }, 120_000);
    afterAll(async () => {
      // Keep SQL/history for root if the actual public shutdown was unconfirmed.
      try {
        if (f && !acceptancePassed) {
          process.stdout.write(
            `NATIVE_CALENDAR_HOST_RETAINED ${JSON.stringify({ schema: f.schema, stateRoot: JSON.parse(process.env.ALLRICE_NATIVE_RECURRING_REFERENCE!).stateRoot })}\n`,
          );
          await client.closeDatabase();
          await f.db.end({ timeout: 5 });
        } else if (f) {
          const [p] =
            await f.db`select closed from allrice_native_once_partitions where partition_id='allrice-recurring-v1'`;
          expect(p?.closed).toBe(true);
          await f.close();
        }
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }, 30_000);
    it('recovers/delivers/decides/retires with fixed coexistence and a cold public reopen', async () => {
      // Vitest injects --require/--conditions. Run the built production code in a
      // normal Node child, never change execArgv or weaken artifact approval.
      const url = new URL(f.databaseUrl),
        authorized = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
      if (
        process.env.DATABASE_URL !== f.databaseUrl ||
        url.pathname !== '/allrice_b2' ||
        url.host !== authorized.host ||
        url.username !== authorized.username ||
        url.password !== authorized.password ||
        !/^p25_[a-f0-9]{32}$/.test(f.schema) ||
        url.searchParams.get('options') !==
          `-csearch_path=${f.schema},public` ||
        process.env.NODE_OPTIONS?.trim()
      )
        throw Error(
          'actual_host_requires_exact_isolated_fixture_and_clean_node_options',
        );
      const [scope] =
        await f.db`select current_schema() schema,current_database() database`;
      if (!scope) throw Error('actual_host_fixture_scope_missing');
      expect(scope.schema).toBe(f.schema);
      expect(scope.database).toBe('allrice_b2');
      const reference = process.env.ALLRICE_NATIVE_RECURRING_REFERENCE!;
      expect(await readdir(JSON.parse(reference).stateRoot)).toEqual([]);
      const env = {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        TZ: process.env.TZ,
        DATABASE_URL: f.databaseUrl,
        ALLRICE_TEST_DATABASE_URL: process.env.ALLRICE_TEST_DATABASE_URL,
        ALLRICE_RUN_DB_INTEGRATION: '1',
        ALLRICE_RUN_NATIVE_CALENDAR_HOST: '1',
        ALLRICE_SERVICE_ROLE: 'worker',
        ALLRICE_ASSISTANTS_ENABLED: '0',
        ALLRICE_EXPERIENCE_REVIEW_ENABLED: '1',
        ALLRICE_NATIVE_RECURRING_ENABLED: '1',
        ALLRICE_NATIVE_CALENDAR_ENABLED: '1',
        ALLRICE_NATIVE_RECURRING_REFERENCE: reference,
        ALLRICE_DSH_NATIVE_ARTIFACT_ID:
          process.env.ALLRICE_DSH_NATIVE_ARTIFACT_ID,
        ALLRICE_NATIVE_CALENDAR_HOST_ARTIFACT_ROOT:
          process.env.ALLRICE_NATIVE_CALENDAR_HOST_ARTIFACT_ROOT,
      };
      const startedAt = new Date().toISOString();
      const pending = run(
        process.execPath,
        [
          fileURLToPath(
            new URL('./native-schedule-calendar-host.mjs', import.meta.url),
          ),
          JSON.stringify({
            schema: f.schema,
            automationId: seeded.automationId,
            P: seeded.P.toISOString(),
            fixedId,
          }),
        ],
        { env, timeout: 170_000, maxBuffer: 8 * 1024 * 1024 },
      );
      const child = pending.child;
      process.stdout.write(
        `NATIVE_CALENDAR_HOST_PARENT_START ${JSON.stringify({ pid: child.pid, startedAt, schema: f.schema, stateRoot: JSON.parse(reference).stateRoot })}\n`,
      );
      let result;
      try {
        result = await pending;
      } catch (error) {
        const stdout = (error as { stdout?: string }).stdout;
        if (stdout)
          process.stdout.write(
            stdout
              .split('\n')
              .filter((s) => s.startsWith('NATIVE_CALENDAR_HOST_'))
              .join('\n') + '\n',
          );
        throw error;
      } finally {
        process.stdout.write(
          `NATIVE_CALENDAR_HOST_PARENT_EXIT ${JSON.stringify({ pid: child.pid, startedAt, endedAt: new Date().toISOString(), exitCode: child.exitCode, signalCode: child.signalCode })}\n`,
        );
      }
      const line = result.stdout
        .split('\n')
        .find((s) => s.startsWith('NATIVE_CALENDAR_HOST_EVIDENCE '));
      expect(line).toBeTruthy();
      const evidence = JSON.parse(
        line!.slice('NATIVE_CALENDAR_HOST_EVIDENCE '.length),
      );
      expect(evidence.models).toBe(0);
      expect(evidence.coldEpoch).toBe(evidence.firstEpoch + 1);
      expect(evidence.retiredTaskId).not.toBe(evidence.nextTaskId);
      process.stdout.write(
        result.stdout
          .split('\n')
          .filter((s) => s.startsWith('NATIVE_CALENDAR_HOST_'))
          .join('\n') + '\n',
      );
      acceptancePassed = true;
    }, 180_000);
  },
);
