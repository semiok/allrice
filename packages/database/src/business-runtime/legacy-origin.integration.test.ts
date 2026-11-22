/** Isolated source-relation contract fixture only. It does not establish
 * current authority or exercise Workflow's still-missing real caller binding. */
import { randomUUID } from 'node:crypto';
import type { MemoryOriginSelectorProjection } from '@allrice/contracts';
import postgres, { type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertRuntimeFixtureDatabase } from '../runtime-fixture-database.ts';
import { ordinaryMemoryPredicate } from '../workspace/employee-memory-primitives.ts';
import { queryLegacyOriginForCaller } from './legacy-origin.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite(
  'legacy origin real SQL, isolated contract fixture without caller authority',
  () => {
    let admin: ReturnType<typeof postgres>;
    let db: ReturnType<typeof postgres>;
    let schema: string;
    const scope = { organizationId: randomUUID(), workspaceId: randomUUID() };
    const memoryScope = {
      ...scope,
      ownerId: randomUUID(),
      instanceId: randomUUID(),
      employeeId: randomUUID(),
    };

    beforeAll(async () => {
      const value = process.env.ALLRICE_TEST_DATABASE_URL;
      if (!value)
        throw new Error('Dedicated ALLRICE_TEST_DATABASE_URL required');
      assertRuntimeFixtureDatabase(new URL(value));
      schema = `legacy_origin_${randomUUID().replaceAll('-', '')}`;
      admin = postgres(value, { max: 1 });
      await admin.unsafe(`create schema ${schema}`);
      db = postgres(value, {
        max: 4,
        connection: { search_path: schema, application_name: schema },
      });
      // Deliberately only the source columns are present. There is no memory
      // table, full runtime fixture, production identity or native producer.
      await db`create table allrice_employee_runs (
      run_id uuid primary key, organization_id uuid not null, workspace_id uuid not null,
      owner_id uuid, employee_id uuid, method_authoring boolean not null,
      user_message_id uuid, assistant_message_id uuid)`;
      await db`create table allrice_context_checkpoints (
      id uuid primary key, organization_id uuid, workspace_id uuid, owner_id uuid,
      covered_through_message_id uuid)`;
    });

    afterAll(async () => {
      try {
        await db?.end({ timeout: 5 });
      } finally {
        try {
          if (admin && schema)
            await admin.unsafe(`drop schema if exists ${schema} cascade`);
        } finally {
          await admin?.end({ timeout: 5 });
        }
      }
    });

    async function runSource(methodAuthoring = true, sourceScope = scope) {
      const userMessageId = randomUUID(),
        assistantMessageId = randomUUID();
      await db`insert into allrice_employee_runs (
      run_id,organization_id,workspace_id,owner_id,employee_id,method_authoring,
      user_message_id,assistant_message_id)
      values(${randomUUID()},${sourceScope.organizationId},${sourceScope.workspaceId},
        ${randomUUID()},${randomUUID()},${methodAuthoring},${userMessageId},${assistantMessageId})`;
      return { userMessageId, assistantMessageId };
    }

    async function checkpoint(covered: string | null, checkpointScope = scope) {
      const id = randomUUID();
      await db`insert into allrice_context_checkpoints
      (id,organization_id,workspace_id,owner_id,covered_through_message_id)
      values(${id},${checkpointScope.organizationId},${checkpointScope.workspaceId},${randomUUID()},${covered})`;
      return id;
    }

    async function compareOldPredicate(
      selector: MemoryOriginSelectorProjection,
      excluded: boolean,
      sourceScope = scope,
    ) {
      return db.begin(async (tx) => {
        const fact = await queryLegacyOriginForCaller(
          tx,
          sourceScope,
          selector,
        );
        expect(fact.excludedByMethodAuthoring).toBe(excluded);
        // The original predicate sees a derived record, never a memory table.
        // Its own scope/private conditions are all satisfied by this fixture.
        const [old] = await tx<{ ordinary: boolean }[]>`
        select (${ordinaryMemoryPredicate(tx, { ...memoryScope, ...sourceScope })}) ordinary
        from (select ${sourceScope.organizationId}::uuid organization_id,
          ${sourceScope.workspaceId}::uuid workspace_id,${memoryScope.ownerId}::uuid owner_id,
          ${memoryScope.instanceId}::uuid instance_id,${memoryScope.employeeId}::uuid employee_id,
          'private'::text visibility,${selector.sourceType}::text source_type,
          ${selector.sourceId}::uuid source_id) m`;
        expect(fact.excludedByMethodAuthoring).toBe(!old!.ordinary);
        return fact;
      });
    }

    it.each(['userMessageId', 'assistantMessageId'] as const)(
      'matches the old exclusion for a method-authoring %s without employee/owner filters',
      async (field) => {
        const run = await runSource();
        expect(
          await compareOldPredicate(
            { sourceType: 'message', sourceId: run[field] },
            true,
          ),
        ).toEqual({ sourceCheck: 'checked', excludedByMethodAuthoring: true });
      },
    );

    it.each(['missing', 'null', 'non-method'] as const)(
      'keeps an authorized message %s match as completed checked/false',
      async (kind) => {
        const sourceId =
          kind === 'null'
            ? null
            : kind === 'non-method'
              ? (await runSource(false)).userMessageId
              : randomUUID();
        expect(
          await compareOldPredicate({ sourceType: 'message', sourceId }, false),
        ).toEqual({ sourceCheck: 'checked', excludedByMethodAuthoring: false });
      },
    );

    it.each([
      'user',
      'assistant',
      'non-method',
      'missing',
      'uncovered',
      'null',
    ] as const)(
      'preserves checkpoint %s covered-through existence semantics',
      async (kind) => {
        const run = await runSource(kind !== 'non-method');
        const sourceId =
          kind === 'missing'
            ? randomUUID()
            : kind === 'null'
              ? null
              : await checkpoint(
                  kind === 'uncovered'
                    ? null
                    : kind === 'assistant'
                      ? run.assistantMessageId
                      : run.userMessageId,
                );
        const excluded = kind === 'user' || kind === 'assistant';
        expect(
          await compareOldPredicate(
            { sourceType: 'checkpoint', sourceId },
            excluded,
          ),
        ).toEqual({
          sourceCheck: 'checked',
          excludedByMethodAuthoring: excluded,
        });
      },
    );

    it.each(['organizationId', 'workspaceId'] as const)(
      'does not classify a Run from another fixture %s as a bound-scope association',
      async (field) => {
        const run = await runSource(true, { ...scope, [field]: randomUUID() });
        await compareOldPredicate(
          { sourceType: 'message', sourceId: run.userMessageId },
          false,
        );
      },
    );

    it('preserves the original checkpoint-by-id relation without adding checkpoint org/owner filters', async () => {
      const run = await runSource();
      const sourceId = await checkpoint(run.userMessageId, {
        organizationId: randomUUID(),
        workspaceId: randomUUID(),
      });
      await compareOldPredicate({ sourceType: 'checkpoint', sourceId }, true);
    });

    it.each(['user', 'tool', 'connector', 'file'])(
      'keeps existing %s sources non-applicable even when an ID happens to match a method Run',
      async (sourceType) => {
        const run = await runSource();
        expect(
          await compareOldPredicate(
            { sourceType, sourceId: run.userMessageId },
            false,
          ),
        ).toEqual({
          sourceCheck: 'not-applicable',
          excludedByMethodAuthoring: false,
        });
      },
    );

    it('returns a settled query fact while the fixture caller transaction remains usable', async () => {
      let callerFinished = false;
      await db.begin(async (tx) => {
        const fact = await queryLegacyOriginForCaller(tx, scope, {
          sourceType: 'message',
          sourceId: randomUUID(),
        });
        expect(fact).toEqual({
          sourceCheck: 'checked',
          excludedByMethodAuthoring: false,
        });
        expect(callerFinished).toBe(false);
        const [row] = await tx`select 1 as still_in_transaction`;
        expect(row!.still_in_transaction).toBe(1);
      });
      callerFinished = true;
      expect(callerFinished).toBe(true);
    });

    it('preserves an actual failed SQL query instead of reporting zero associations', async () => {
      await expect(
        db.begin(async (tx) => {
          await tx`alter table allrice_context_checkpoints rename to fixture_hidden_checkpoints`;
          return queryLegacyOriginForCaller(tx, scope, {
            sourceType: 'checkpoint',
            sourceId: randomUUID(),
          });
        }),
      ).rejects.toMatchObject({ code: '42P01' });
      // The failed fixture transaction rolled its DDL back; source availability
      // is restored without a retry or changing the original failure receipt.
      await compareOldPredicate(
        { sourceType: 'checkpoint', sourceId: randomUUID() },
        false,
      );
    });

    it('joins actual lock-blocked SQL cancellation before returning the original caller reason', async () => {
      const controller = new AbortController();
      const reason = new Error('fixture caller cancelled original source read');
      let sqlSettled = false,
        classifierSettled = false;
      let readerPid: number | undefined;
      let pending: Promise<{ value?: unknown; error?: unknown }> | undefined;
      await db.begin(async (blocker) => {
        const [holder] = await blocker`select pg_backend_pid() pid`;
        await blocker`lock table allrice_employee_runs in access exclusive mode`;
        try {
          pending = db
            .begin(async (tx) => {
              await tx`set local statement_timeout='8s'`;
              const [reader] = await tx`select pg_backend_pid() pid`;
              readerPid = reader!.pid as number;
              // This instrumentation returns the real driver's PendingQuery. It
              // only observes its settlement; it does not fake SQL or authority.
              const observedTx = ((
                strings: TemplateStringsArray,
                ...parameters: unknown[]
              ) => {
                const query = Reflect.apply(tx, undefined, [
                  strings,
                  ...parameters,
                ]) as postgres.PendingQuery<{ excluded: boolean }[]>;
                void query.then(
                  () => {
                    sqlSettled = true;
                  },
                  () => {
                    sqlSettled = true;
                  },
                );
                return query;
              }) as unknown as TransactionSql;
              return queryLegacyOriginForCaller(
                observedTx,
                scope,
                { sourceType: 'message', sourceId: randomUUID() },
                controller.signal,
              ).then(
                (value) => {
                  classifierSettled = true;
                  expect(sqlSettled).toBe(true);
                  return value;
                },
                (error: unknown) => {
                  classifierSettled = true;
                  expect(sqlSettled).toBe(true);
                  throw error;
                },
              );
            })
            .then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
          await expect
            .poll(
              async () => {
                if (readerPid === undefined) return false;
                const [row] = await db<{ blocked: boolean }[]>`
            select ${holder!.pid}::int=any(pg_blocking_pids(${readerPid})) blocked`;
                return row!.blocked;
              },
              { timeout: 5000, interval: 10 },
            )
            .toBe(true);
          expect(sqlSettled).toBe(false);
          expect(classifierSettled).toBe(false);
          controller.abort(reason);
          const result = await pending;
          expect(result.error).toBe(reason);
          expect(sqlSettled).toBe(true);
          expect(classifierSettled).toBe(true);
        } finally {
          controller.abort(reason);
          await pending;
        }
      });
    });
  },
);
