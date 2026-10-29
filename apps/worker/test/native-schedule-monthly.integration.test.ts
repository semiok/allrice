import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  employeeManifest,
  employeeManifestChecksum,
} from '../../../packages/database/src/employees/employee-config.ts';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { createChatSession } from '../../../packages/database/src/workspace/service.ts';
import {
  createRecurringTask,
  initializeNativeRecurringPartition,
} from '../../../packages/database/src/native-schedule-recurring-product.ts';
import * as client from '../../../packages/database/src/core/client.ts';
import { parseNativeScheduleControlReference } from '../src/native-schedule-once-loader.ts';

const run = promisify(execFile);
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' &&
  process.env.ALLRICE_RUN_NATIVE_CALENDAR_HOST === '1' &&
  process.env.ALLRICE_RUN_NATIVE_MONTHLY_HOST === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'ordinary monthly public Host original chat handoff, fixed coexistence and zero model calls',
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let seeded: { automationId: string; P: Date };
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
      vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '0');
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
      // The original chat queue requires an actual published ordinary employee
      // definition, identical to the isolated fixed/ordinary SQL acceptance.
      const manifest = employeeManifest({
        key: 'p27-codex-worker',
        name: 'Monthly actual Host fixture',
        description: 'No provider execution',
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
      await initializeNativeRecurringPartition(reference);
      const monthlyChat = await createChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: 'Ordinary monthly original work',
      });
      const futureP = new Date(Math.floor((Date.now() + 10000) / 1000) * 1000);
      const rule = {
        kind: 'monthly' as const,
        monthDay: futureP.getUTCDate(),
        time: futureP.toISOString().slice(11, 19),
        timezone: 'UTC',
      };
      const monthly = await createRecurringTask(f.context, monthlyChat.id, {
        clientRequestId: randomUUID(),
        name: 'Ordinary monthly actual native cycle',
        prompt:
          '核对本会话报表，分别列出金额和异常。本次只准备原始聊天工作，不调用模型。',
        rule,
      });
      expect(monthly).toMatchObject({
        status: 'preparing',
        rule,
        nextRunAt: null,
      });
      const [saved] = await f.db<
        { next_run_at: Date }[]
      >`select next_run_at from allrice_automations where id=${monthly.id}`;
      expect(saved!.next_run_at).toEqual(futureP);
      seeded = { automationId: monthly.id, P: futureP };
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
      // No Host exists yet. Let this genuinely saved future monthly P become
      // overdue; recovery must retain P and create an actual short future A.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, seeded.P.getTime() + 100 - Date.now())),
      );
      expect(seeded.P.getTime()).toBeLessThan(Date.now());
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
    it(
      'recovers/delivers/retires with live Session enrollment, fixed coexistence and cold reopen',
      {
        tags: [
          'manual:ALLRICE_RUN_NATIVE_CALENDAR_HOST',
          'manual:ALLRICE_RUN_NATIVE_MONTHLY_HOST',
        ],
        timeout: 180_000,
      },
      async () => {
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
          ALLRICE_EXPERIENCE_REVIEW_ENABLED: '0',
          ALLRICE_RUN_NATIVE_MONTHLY_HOST: '1',
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
              consumer: 'ordinary-monthly-v1',
              automationId: seeded.automationId,
              P: seeded.P.toISOString(),
              fixedId,
              lateEnrollment: {
                context: f.context,
                employeeAssignmentId: f.assignmentId,
              },
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
        expect(evidence.consumer).toBe('ordinary-monthly-v1');
        expect(evidence.businessRunId).toBeTruthy();
        expect(evidence.ordinaryJobId).toBeTruthy();
        expect(evidence.liveAddition).toMatchObject({
          pid: child.pid,
          originalEpoch: evidence.firstEpoch,
          reopenedEpoch: evidence.firstEpoch + 1,
          initialHistoryCount: 2,
          historyCount: 3,
          refreshClose: { kind: 'public_host_backend_drained' },
        });
        expect(evidence.liveAddition.automationId).not.toBe(
          seeded.automationId,
        );
        expect(evidence.liveAddition.automationId).not.toBe(fixedId);
        expect(Date.parse(evidence.liveAddition.P)).toBeGreaterThan(
          Date.now() + 7 * 86_400_000,
        );
        expect(evidence.runningEpoch).toBe(evidence.liveAddition.reopenedEpoch);
        expect(evidence.coldEpoch).toBe(evidence.runningEpoch + 1);
        expect(evidence.firstHistoryCount).toBe(3);
        expect(evidence.coldHistoryCount).toBe(3);
        expect(evidence.durable.controls).toHaveLength(3);
        expect(evidence.retiredTaskId).not.toBe(evidence.nextTaskId);
        process.stdout.write(
          result.stdout
            .split('\n')
            .filter((s) => s.startsWith('NATIVE_CALENDAR_HOST_'))
            .join('\n') + '\n',
        );
        acceptancePassed = true;
      },
    );
  },
);
