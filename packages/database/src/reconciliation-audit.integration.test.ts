import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import { recordToolBrokerAudit } from './execution/tool-broker.ts';
import type * as Client from './core/client.ts';
import {
  assertReconciliationAudits,
  readReconciliationAudits,
  saveReconciliationAssistantMessage,
} from '../../../scripts/acceptance/runtime/reconciliation-audit.ts';

let db: ReturnType<typeof postgres>,
  admin: ReturnType<typeof postgres>,
  storageRoot: string;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `p19_audit_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const tools = [
  'workspace.skill.read',
  'workspace.skill.read',
  'cloud.process.execute',
  'workspace.reconciliation.export',
];
const fixture = async () => {
  const f = await createCloudExecutionFixture(db, storageRoot);
  const scope = {
    organizationId: f.org,
    workspaceId: f.workspace,
    actorId: f.user,
    runId: f.run,
    executionId: f.execution.executionId,
  };
  return { f, scope };
};

suite(
  'P19 acceptance SQL, real PostgreSQL/audit writer, no model or sandbox',
  () => {
    beforeAll(async () => {
      if (!process.env.ALLRICE_TEST_DATABASE_URL)
        throw Error('Dedicated database required');
      const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL);
      const local =
        ['127.0.0.1', 'localhost'].includes(url.hostname) &&
        url.port === '5432' &&
        url.username === 'a123' &&
        url.pathname === '/allrice_b2';
      const ci =
        url.hostname === '127.0.0.1' &&
        url.port === '54329' &&
        url.username === 'allrice' &&
        url.pathname === '/allrice';
      if (!local && !ci)
        throw Error('Only dedicated local B2 or CI database permitted');
      admin = postgres(url.toString(), { max: 2, onnotice: () => {} });
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(20260907,1)`;
        await tx`create extension if not exists vector with schema public`;
        await tx`create extension if not exists pg_trgm with schema public`;
      });
      await admin.unsafe(`create schema ${schema}`);
      url.searchParams.set('options', `-csearch_path=${schema},public`);
      db = postgres(url.toString(), { max: 10, onnotice: () => {} });
      const migrations = new URL('../migrations/', import.meta.url);
      for (const file of (await readdir(migrations))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await db.unsafe(await readFile(new URL(file, migrations), 'utf8'));
      storageRoot = await mkdtemp(join(tmpdir(), 'allrice-p19-audit-'));
    }, 60000);
    afterAll(async () => {
      await db?.end();
      if (admin) {
        if (!/^p19_audit_[a-f0-9]{32}$/.test(schema))
          throw Error('Unsafe test schema');
        await admin.unsafe(`drop schema ${schema} cascade`);
        await admin.end();
      }
      if (storageRoot?.includes('/allrice-p19-audit-'))
        await rm(storageRoot, { recursive: true, force: true });
    });

    it('executes the exact preflight query on the real schema before any model/tool call', async () => {
      const { scope } = await fixture();
      expect(await readReconciliationAudits(db, scope)).toEqual([]);
      await expect(
        db`select id from allrice_audit_events order by created_at limit 0`,
      ).rejects.toMatchObject({ code: '42703' });
    });

    it('reads real recordToolBrokerAudit rows, allowing exactly the actual tool counts', async () => {
      const { f, scope } = await fixture();
      for (const toolName of tools)
        await recordToolBrokerAudit({
          context: f.execution,
          toolName,
          metadata: { syntheticUnprojected: 'not emitted in evidence' },
        });
      const audits = await readReconciliationAudits(db, scope);
      assertReconciliationAudits(audits, scope, tools);
      expect(audits).toHaveLength(4);
      expect(
        audits.every(
          (audit) =>
            !('metadata' in audit) && !('syntheticUnprojected' in audit),
        ),
      ).toBe(true);
      for (const key of Object.keys(scope) as (keyof typeof scope)[])
        expect(
          await readReconciliationAudits(db, { ...scope, [key]: randomUUID() }),
        ).toEqual([]);
    });

    it('does not borrow another tenant/workspace/actor/Run/execution audit to fill missing evidence', async () => {
      const { f, scope } = await fixture();
      const other = await fixture();
      const otherWorkspace = randomUUID();
      await db`insert into allrice_workspaces(id,organization_id,slug,name)
      values(${otherWorkspace},${f.org},'other','Synthetic other workspace')`;
      const neighbors = [
        {
          ...f.execution,
          organizationId: other.f.org,
          workspaceId: other.f.workspace,
        },
        { ...f.execution, workspaceId: otherWorkspace },
        {
          ...f.execution,
          policySnapshot: {
            ...f.execution.policySnapshot,
            subjectId: other.f.user,
          },
        },
        { ...f.execution, runId: randomUUID() },
        { ...f.execution, executionId: randomUUID() },
      ];
      for (const context of neighbors)
        await recordToolBrokerAudit({
          context,
          toolName: 'cloud.process.execute',
        });
      expect(await readReconciliationAudits(db, scope)).toEqual([]);
      expect(() => assertReconciliationAudits([], scope, tools)).toThrow();
      for (const toolName of tools)
        await recordToolBrokerAudit({ context: f.execution, toolName });
      assertReconciliationAudits(
        await readReconciliationAudits(db, scope),
        scope,
        tools,
      );
    });

    it('rejects missing, extra and denied real tool audit rows', async () => {
      for (const scenario of ['missing', 'extra', 'denied'] as const) {
        const { f, scope } = await fixture();
        const actual =
          scenario === 'missing'
            ? tools.slice(0, 3)
            : scenario === 'extra'
              ? [...tools, tools[0]!]
              : tools;
        for (const [index, toolName] of actual.entries())
          await recordToolBrokerAudit({
            context: f.execution,
            toolName,
            decision:
              scenario === 'denied' && index === 3 ? 'denied' : 'allowed',
          });
        const rows = await readReconciliationAudits(db, scope);
        expect(() => assertReconciliationAudits(rows, scope, tools)).toThrow();
      }
    });

    it('saves the assistant message through the exact final scoped SQL and refuses missing/wrong scope or user role', async () => {
      const { f, scope } = await fixture();
      const [run] =
        await db`select assistant_message_id,user_message_id from allrice_employee_runs where run_id=${f.run}`;
      const messageScope = {
        ...scope,
        sessionId: f.session,
        messageId: run!.assistant_message_id as string,
      };
      await saveReconciliationAssistantMessage(
        db,
        messageScope,
        'verified synthetic answer',
      );
      const [saved] =
        await db`select content from allrice_messages where id=${messageScope.messageId}`;
      expect(saved!.content).toEqual({
        text: 'verified synthetic answer',
        citations: [],
      });
      for (const key of [
        'organizationId',
        'workspaceId',
        'actorId',
        'runId',
        'sessionId',
        'messageId',
      ] as const)
        await expect(
          saveReconciliationAssistantMessage(
            db,
            { ...messageScope, [key]: randomUUID() },
            'must not save',
          ),
        ).rejects.toThrow(
          'Only this synthetic session assistant message was saved',
        );
      await expect(
        saveReconciliationAssistantMessage(
          db,
          { ...messageScope, messageId: run!.user_message_id },
          'must not save',
        ),
      ).rejects.toThrow(
        'Only this synthetic session assistant message was saved',
      );
      const [unchanged] =
        await db`select content from allrice_messages where id=${messageScope.messageId}`;
      expect(unchanged!.content.text).toBe('verified synthetic answer');
    });
  },
);
