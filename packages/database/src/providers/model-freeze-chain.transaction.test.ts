import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as client from '../core/client.ts';
import {
  freezeExperienceModelSnapshot,
  freezeSessionModelSnapshot,
} from './model-pool.ts';

type Stage =
  | 'session'
  | 'settings'
  | 'policy'
  | 'catalog'
  | 'selection'
  | 'subscription'
  | 'cache';

function fixture() {
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const employeeId = randomUUID();
  const ownerId = randomUUID();
  const sessionId = randomUUID();
  const employeeVersionId = randomUUID();
  const catalogId = randomUUID();
  const configuration = {
    connectionId: '52000000-0000-4000-8000-000000000001',
    workModel: 'gpt-6.1-sol',
    reasoningEffort: 'high',
    timeoutMs: 600_000,
    imageModel: 'auto',
    imagesEnabled: true,
  };
  const settings = {
    revision: 7,
    configuration,
    updated_at: new Date('2026-10-20T00:00:00.000Z'),
  };
  const policy = {
    employee_id: employeeId,
    organization_id: organizationId,
    workspace_id: workspaceId,
    connection_id: configuration.connectionId,
    model_catalog_entry_id: '53000000-0000-4000-8000-000000000001',
    reasoning_effort: 'xhigh',
    fallback_policy: 'disabled',
    fallback_targets: [],
    fallback_on: ['provider_unavailable'],
    timeout_ms: 300_000,
    max_input_tokens: 120_000,
    max_output_tokens: 16_000,
    max_total_tokens: 136_000,
    max_cost_cents: null,
    revision: 99,
    updated_by: ownerId,
    updated_at: settings.updated_at,
  };
  return {
    scope: { organizationId, workspaceId, sessionId, employeeVersionId },
    experience: {
      organizationId,
      workspaceId,
      employeeId,
      ownerId,
      occurrenceId: randomUUID(),
    },
    employeeId,
    catalogId,
    settings,
    policy,
    session: {
      employee_id: employeeId,
      owner_id: ownerId,
      version_id: employeeVersionId,
      manifest: {},
    },
    selection: {
      harness: 'codex',
      provider_key: 'codex',
      auth_mode: 'chatgpt_subscription',
      model: configuration.workModel,
      credential_reference: 'deployment:codex-default',
      base_url: null,
    },
  };
}

// A recording tag exercises real production functions but does not run SQL or
// prove actual permissions, connection pinning, rollback or cache predicates.
// Deliberately no begin/savepoint implementation: supplied transactions must
// not be treated as connection pools that can open another transaction.
function reader(
  f: ReturnType<typeof fixture>,
  options: {
    allowed?: Stage[];
    sessionMissing?: boolean;
    subscriptionDisabled?: boolean;
    cacheSkipped?: boolean;
    failure?: { stage: Stage; error: Error };
  } = {},
  trace: string[] = [],
) {
  const calls: { stage: Stage; values: unknown[] }[] = [];
  const query = vi.fn(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join('?').replace(/\s+/g, ' ').trim();
      let stage: Stage;
      if (text.startsWith('select a.employee_id, s.owner_id'))
        stage = 'session';
      else if (
        text.includes('from allrice_platform_model_settings where singleton')
      )
        stage = 'settings';
      else if (text.startsWith('insert into allrice_employee_model_policies'))
        stage = 'policy';
      else if (
        text.startsWith('select m.id from allrice_model_catalog_entries')
      )
        stage = 'catalog';
      else if (text.startsWith('select p.harness, p.provider_key'))
        stage = 'selection';
      else if (text.startsWith('select slot from allrice_codex_subscriptions'))
        stage = 'subscription';
      else if (text.startsWith('insert into allrice_session_model_snapshots'))
        stage = 'cache';
      else throw Error(`unexpected_sql_fixture_query: ${text}`);
      if (options.allowed && !options.allowed.includes(stage)) {
        throw Error(`query_used_wrong_default_reader: ${stage}`);
      }
      trace.push(`query:${stage}`);
      calls.push({ stage, values });
      if (options.failure?.stage === stage) throw options.failure.error;
      switch (stage) {
        case 'session':
          return options.sessionMissing ? [] : [f.session];
        case 'settings':
          return [f.settings];
        case 'policy':
          return [f.policy];
        case 'catalog':
          return [{ id: f.catalogId }];
        case 'selection':
          return [f.selection];
        case 'subscription':
          return options.subscriptionDisabled ? [] : [{ slot: 2 }];
        case 'cache':
          return options.cacheSkipped ? [] : [{ snapshot: values[7] }];
      }
    },
  );
  const json = vi.fn((value: unknown) => value);
  return {
    sql: Object.assign(query, { json }) as unknown as TransactionSql,
    calls,
    json,
  };
}

function forbidPool() {
  return vi.spyOn(client, 'getDatabase').mockImplementation(() => {
    throw Error('unexpected_global_database');
  });
}

function defaultReaders(f: ReturnType<typeof fixture>, experience = false) {
  const trace: string[] = [];
  const phases: [string, Stage[]][] = [
    ['target', ['catalog']],
    ['settings', ['settings']],
    ['policy', ['policy']],
    ['selection', ['selection']],
    ['subscription', ['subscription']],
  ];
  if (!experience) phases.unshift(['session', ['session', 'cache']]);
  const readers = phases.map(([name, allowed]) => ({
    name,
    reader: reader(f, { allowed }, trace),
  }));
  let next = 0;
  const pool = vi.spyOn(client, 'getDatabase').mockImplementation(() => {
    const selected = readers[next++];
    if (!selected) throw Error('unexpected_default_reader_acquisition');
    trace.push(`get:${selected.name}`);
    return selected.reader.sql as unknown as ReturnType<
      typeof client.getDatabase
    >;
  });
  return { pool, trace };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('model freeze chain caller transaction forwarding', () => {
  it('routes every Session SQL statement and JSON parameter to one supplied tag', async () => {
    const pool = forbidPool();
    const f = fixture();
    const tx = reader(f);
    const snapshot = await freezeSessionModelSnapshot(f.scope, tx.sql);
    expect(pool).not.toHaveBeenCalled();
    expect(tx.calls.map((call) => call.stage)).toEqual([
      'session',
      'settings',
      'policy',
      'catalog',
      'selection',
      'subscription',
      'cache',
    ]);
    expect(tx.calls[0]?.values).toEqual([
      f.scope.employeeVersionId,
      f.scope.organizationId,
      f.scope.workspaceId,
      f.scope.sessionId,
    ]);
    expect(tx.json).toHaveBeenCalledTimes(3);
    expect(snapshot).toMatchObject({
      sessionId: f.scope.sessionId,
      employeeId: f.employeeId,
      policyRevision: f.settings.revision,
      provider: 'openai-codex',
      harness: 'dsh',
      model: f.settings.configuration.workModel,
      reasoningEffort: f.settings.configuration.reasoningEffort,
      credentialReference: 'deployment:codex-default',
      baseUrl: null,
      fallbackPolicy: 'disabled',
      resolvedFallbacks: [],
      runLimits: { timeoutMs: 600_000, maxInputTokens: 120_000 },
      platformSettings: { configuration: f.settings.configuration },
    });
  });

  it('preserves all six default Session acquisition phases and query order', async () => {
    const f = fixture();
    const defaults = defaultReaders(f);
    await freezeSessionModelSnapshot(f.scope);
    expect(defaults.pool).toHaveBeenCalledTimes(6);
    expect(defaults.trace).toEqual([
      'get:session',
      'query:session',
      'get:target',
      'get:settings',
      'query:settings',
      'get:policy',
      'query:policy',
      'query:catalog',
      'get:selection',
      'query:selection',
      'get:subscription',
      'query:subscription',
      'query:cache',
    ]);
  });

  it('shares a supplied tag through Experience while retaining original caps', async () => {
    const pool = forbidPool();
    const f = fixture();
    const tx = reader(f);
    const snapshot = await freezeExperienceModelSnapshot(f.experience, tx.sql);
    expect(pool).not.toHaveBeenCalled();
    expect(tx.calls.map((call) => call.stage)).toEqual([
      'settings',
      'policy',
      'catalog',
      'selection',
      'subscription',
    ]);
    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      sessionId: null,
      occurrenceId: f.experience.occurrenceId,
      runLimits: {
        timeoutMs: 300_000,
        maxInputTokens: 24_000,
        maxOutputTokens: 4_000,
        maxTotalTokens: 28_000,
      },
    });
  });

  it('preserves the five default Experience acquisition phases', async () => {
    const f = fixture();
    const defaults = defaultReaders(f, true);
    await freezeExperienceModelSnapshot(f.experience);
    expect(defaults.pool).toHaveBeenCalledTimes(5);
    expect(defaults.trace).toEqual([
      'get:target',
      'get:settings',
      'query:settings',
      'get:policy',
      'query:policy',
      'query:catalog',
      'get:selection',
      'query:selection',
      'get:subscription',
      'query:subscription',
    ]);
  });

  it('rejects a missing Session before acquiring any downstream default reader', async () => {
    const f = fixture();
    const sql = reader(f, { sessionMissing: true });
    const pool = vi
      .spyOn(client, 'getDatabase')
      .mockReturnValue(
        sql.sql as unknown as ReturnType<typeof client.getDatabase>,
      );
    await expect(freezeSessionModelSnapshot(f.scope)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(pool).toHaveBeenCalledTimes(1);
    expect(sql.calls.map((call) => call.stage)).toEqual(['session']);
  });

  it('keeps the current disabled-subscription failure before any cache write', async () => {
    const pool = forbidPool();
    const f = fixture();
    const tx = reader(f, { subscriptionDisabled: true });
    await expect(
      freezeSessionModelSnapshot(f.scope, tx.sql),
    ).rejects.toMatchObject({
      code: 'disabled',
    });
    expect(tx.calls.at(-1)?.stage).toBe('subscription');
    expect(tx.calls.some((call) => call.stage === 'cache')).toBe(false);
    expect(pool).not.toHaveBeenCalled();
  });

  it('propagates a target SQL error without retry or pool fallback', async () => {
    const pool = forbidPool();
    const f = fixture();
    const error = Error('selection_query_failed');
    const tx = reader(f, { failure: { stage: 'selection', error } });
    await expect(freezeSessionModelSnapshot(f.scope, tx.sql)).rejects.toBe(
      error,
    );
    expect(tx.calls.at(-1)?.stage).toBe('selection');
    expect(pool).not.toHaveBeenCalled();
  });

  it('returns this Run snapshot when the cache upsert returns no row', async () => {
    const pool = forbidPool();
    const f = fixture();
    const tx = reader(f, { cacheSkipped: true });
    expect(await freezeSessionModelSnapshot(f.scope, tx.sql)).toMatchObject({
      sessionId: f.scope.sessionId,
      policyRevision: f.settings.revision,
      model: f.settings.configuration.workModel,
    });
    expect(pool).not.toHaveBeenCalled();
  });
});
