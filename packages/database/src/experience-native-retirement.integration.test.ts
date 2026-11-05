/** Actual shared calendar generation + SQL, synthetic Host ports, no model. */
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { createNativeCalendarGeneration } from '../../../apps/worker/src/native-schedule-calendar.ts';
import type { NativeScheduleControlHost } from '../../../apps/worker/src/native-schedule-once.ts';
import {
  seedExperienceCalendarRule,
  seedHistoricalExperienceCalendar,
} from './experience-native.fixture.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from './employees/employee-config.ts';
import { createChatSession } from './workspace/service.ts';
import {
  createRecurringTask,
  dispatchNextNativeRecurringOccurrence,
} from './native-schedule-recurring-product.ts';
import { materializeNativeCalendar } from './native-schedule-calendar-consumers.ts';
import {
  nativeOnceDigest,
  type NativeOnceTask,
} from './native-schedule-once-state.ts';
import type { NativeCalendarMutation } from './native-schedule-calendar-state.ts';
import * as client from './core/client.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('M5-A historical native arms preserve the shared generation', () => {
  let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
  const reference = {
    artifactId: 'sha256:' + 'a'.repeat(64),
    profileId: 'allrice-recurring-control-v1',
    storageId: 'retirement-sql',
    stateRoot: '/isolated/retirement-sql',
  };
  beforeEach(async () => {
    vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '1');
    vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
    vi.stubEnv('ALLRICE_NATIVE_CALENDAR_ENABLED', '1');
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    vi.stubEnv('ALLRICE_NATIVE_RECURRING_REFERENCE', JSON.stringify(reference));
    f = await createP27CodexWorkerFixture({
      allowCiDatabase: true,
      personalProfile: 'writable',
    });
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Error('No model/network in retirement SQL tests'),
    );
  }, 120000);
  afterEach(async () => {
    try {
      await f?.close();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  }, 30000);

  async function monthly() {
    const manifest = employeeManifest({
      key: 'p27-codex-worker',
      name: 'Ordinary monthly retention',
      description: 'Synthetic SQL only',
      toolNames: ['automation.create'],
      runtimePolicy: {
        harness: 'dsh',
        provider: 'openai-codex',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'low',
        timeoutMs: f.runLimits.timeoutMs,
        fallbackModels: [],
        credentialReference: 'deployment:codex-default',
        baseUrl: null,
      },
      securityPolicy: {
        dataScopes: ['workspace'],
        connectorIdentityModes: ['user'],
        approvalPolicy: 'confirm_side_effects',
        deniedCapabilities: ['secret:use', 'network:outbound'],
      },
    });
    const versionId = randomUUID();
    await f.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
      values(${versionId},${f.organizationId},${f.workspaceId},${f.employeeId},2,${manifest.name},${manifest.provider.model},${manifest.systemPrompt},${f.db.json(manifest.capabilities)},${employeeManifestChecksum(manifest)},${f.db.json(manifest)},${f.db.json(manifest.provider)})`;
    await f.db`update allrice_employee_assignments set employee_version_id=${versionId} where id=${f.assignmentId}`;
    const session = await createChatSession(f.context, {
      workspaceId: f.workspaceId,
      employeeAssignmentId: f.assignmentId,
      title: 'Synthetic monthly retention',
    });
    return createRecurringTask(f.context, session.id, {
      clientRequestId: randomUUID(),
      name: 'Synthetic ordinary monthly',
      prompt: 'Synthetic reminder, no model in this test.',
      rule: {
        kind: 'monthly',
        monthDay: 28,
        time: '10:00:00',
        timezone: 'UTC',
      },
    });
  }

  it.each(['prepared', 'absent', 'creating'] as const)(
    'finishes a retained %s arm beside an ordinary monthly arm without reviving experience business',
    async (phase) => {
      const seeded = await seedExperienceCalendarRule(f, 'empty');
      const old = await seedHistoricalExperienceCalendar(
        f,
        seeded.automationId,
        reference,
        phase,
      );
      const { store } = old,
        ports = store.calendar!;
      let writer = old.writer;
      if (phase === 'creating') {
        // Synthetic old generation is closed; actual SQL enforces the new epoch.
        await store.releaseClosedWriter(writer);
        writer = (await store.acquireWriter())!.writer;
        expect(writer.epoch).toBe(old.writer.epoch + 1);
      }
      const ordinary = await monthly();
      expect(await materializeNativeCalendar(ports, writer, reference)).toBe(
        true,
      );
      const mutate = async (mutation: NativeCalendarMutation) => {
        expect(
          await store.commitMutation(writer, {
            writeId: randomUUID(),
            digest: nativeOnceDigest(mutation),
            mutation,
          }),
        ).toBe('committed');
      };
      for (const c of (await ports.loadCalendarState(writer)).controls) {
        if (c.control.sessionState !== 'reserved') continue;
        await mutate({
          kind: 'calendar',
          action: 'session_initializing',
          controlId: c.control.controlId,
          expectedControlVersion: c.version,
        });
        await mutate({
          kind: 'calendar',
          action: 'session_ready',
          controlId: c.control.controlId,
          expectedControlVersion: c.version + 1,
        });
      }
      const created: string[] = [];
      const host = {
        decodeTask: (value: unknown) =>
          structuredClone(value) as NativeOnceTask,
        catalog: async () =>
          Object.values(await store.loadTaskRecords(writer)).map((raw) => {
            const task = raw as NativeOnceTask;
            return {
              ...task.record,
              sessionId: task.sessionId,
              status: task.status,
              lastDelivery: task.lastDelivery,
            };
          }),
        createOnce: async (sessionId: string, at: string) => {
          const state = await ports.loadCalendarState(writer);
          const c = state.controls.find(
            (x) => x.control.controlSessionId === sessionId,
          )!.control;
          const b = state.bindings.find(
            (x) =>
              x.period.controlId === c.controlId && x.arm.status === 'creating',
          )!;
          const task: NativeOnceTask = {
            sessionId,
            status: 'active',
            record: {
              id: randomUUID(),
              kind: 'at',
              title: 'AllRice once control',
              prompt:
                'Synthetic schedule control only. Never execute business work.',
              scheduledAt: at,
            },
          };
          await mutate({
            kind: 'calendar',
            action: 'put_task',
            controlId: c.controlId,
            periodId: b.period.periodId,
            armId: b.arm.armId,
            requestDigest: b.arm.requestDigest,
            expectedPeriodVersion: b.period.version,
            expectedArmVersion: b.arm.snapshotVersion,
            task,
          });
          created.push(c.automationId);
          return task.record;
        },
      } as unknown as NativeScheduleControlHost;
      const generation = createNativeCalendarGeneration({
        ports: {
          ...ports,
          materialize: (w, allow) =>
            materializeNativeCalendar(ports, w, reference, allow),
        },
        writer,
        host: () => host,
        fence: async () => {
          expect(await store.assertWriter(writer)).toBe(true);
        },
        mutate,
        track: async (work) => work,
        loadTaskRecords: () => store.loadTaskRecords(writer),
        digest: nativeOnceDigest,
      });
      await expect(generation.tick()).resolves.toBeUndefined();
      expect(created.sort()).toEqual([seeded.automationId, ordinary.id].sort());
      await expect(generation.tick()).resolves.toBeUndefined();
      expect(created).toHaveLength(2);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        false,
      );
      expect(
        await f.db`select id from allrice_automation_runs where experience_occurrence is not null`,
      ).toHaveLength(0);
      expect(await f.db`select id from allrice_jobs`).toHaveLength(0);
      expect(
        await f.db`select period_id from allrice_native_calendar_periods where automation_id=${seeded.automationId}`,
      ).toHaveLength(1);
    },
  );

  it('still closes genuinely revoked historical arms without fabricating retirement authority', async () => {
    const seeded = await seedExperienceCalendarRule(f, 'empty');
    const old = await seedHistoricalExperienceCalendar(
      f,
      seeded.automationId,
      reference,
      'prepared',
    );
    await f.db`update allrice_employee_instances set archived_at=clock_timestamp() where id=${old.control.dispatch.employeeInstanceId}`;
    expect(
      await materializeNativeCalendar(
        old.store.calendar!,
        old.writer,
        reference,
      ),
    ).toBe(true);
    const state = await old.store.calendar!.loadCalendarState(old.writer);
    expect(state.bindings.every((b) => b.closed)).toBe(true);
    expect(
      await f.db`select outcome from allrice_native_calendar_decisions where period_id=${old.period.periodId}`,
    ).toEqual([{ outcome: 'authority_blocked' }]);
    expect(await f.db`select id from allrice_jobs`).toHaveLength(0);
  });
});
