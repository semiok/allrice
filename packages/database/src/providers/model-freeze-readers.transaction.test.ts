import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as client from '../core/client.ts';
import { readPlatformModelSettings } from './platform-model-settings.ts';
import {
  readEnabledCodexSubscription,
  requireEnabledCodexSubscription,
} from './codex-subscriptions.ts';

// This tag records argument routing only. It is not a PostgreSQL transaction,
// does not evaluate SQL, and cannot prove transactional visibility or rollback.
function recordingReader(rows: unknown[]) {
  const query = vi.fn<
    (...args: [TemplateStringsArray, ...unknown[]]) => Promise<unknown[]>
  >(async () => rows);
  return { query, sql: query as unknown as TransactionSql };
}

function settingsRow() {
  return {
    revision: 7,
    configuration: {
      connectionId: randomUUID(),
      workModel: 'gpt-5.6-luna',
      reasoningEffort: 'high',
      timeoutMs: 600_000,
      imageModel: 'auto',
      imagesEnabled: true,
    },
    updated_at: new Date('2026-10-20T00:00:00.000Z'),
  };
}

function forbidPool() {
  return vi.spyOn(client, 'getDatabase').mockImplementation(() => {
    throw Error('unexpected_global_database');
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('model freeze shared-reader transaction prerequisites', () => {
  it('routes settings through the supplied tag and preserves its projection', async () => {
    const pool = forbidPool();
    const row = settingsRow();
    const reader = recordingReader([row]);
    await expect(readPlatformModelSettings(reader.sql)).resolves.toEqual({
      revision: row.revision,
      configuration: row.configuration,
      updatedAt: row.updated_at.toISOString(),
    });
    expect(reader.query).toHaveBeenCalledTimes(1);
    expect(pool).not.toHaveBeenCalled();
  });

  it('keeps missing settings rejected without falling back to the pool', async () => {
    const pool = forbidPool();
    const reader = recordingReader([]);
    await expect(readPlatformModelSettings(reader.sql)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(pool).not.toHaveBeenCalled();
  });

  it('forwards the supplied tag through the required subscription reader', async () => {
    const pool = forbidPool();
    const reader = recordingReader([{ slot: 2 }]);
    expect(await readEnabledCodexSubscription(reader.sql)).toBe(2);
    expect(await requireEnabledCodexSubscription(reader.sql)).toBe(2);
    expect(reader.query).toHaveBeenCalledTimes(2);
    expect(pool).not.toHaveBeenCalled();
  });

  it('keeps all-off null and disabled behavior on the supplied reader', async () => {
    const pool = forbidPool();
    const reader = recordingReader([]);
    expect(await readEnabledCodexSubscription(reader.sql)).toBeNull();
    await expect(
      requireEnabledCodexSubscription(reader.sql),
    ).rejects.toMatchObject({ code: 'disabled' });
    expect(pool).not.toHaveBeenCalled();
  });

  it('propagates SQL errors from both readers without another connection', async () => {
    const pool = forbidPool();
    const error = Error('transaction_reader_failed');
    const query = vi.fn(async () => {
      throw error;
    });
    const reader = query as unknown as TransactionSql;
    await expect(readPlatformModelSettings(reader)).rejects.toBe(error);
    await expect(requireEnabledCodexSubscription(reader)).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(2);
    expect(pool).not.toHaveBeenCalled();
  });

  it('preserves one default acquisition per existing read invocation', async () => {
    const row = settingsRow();
    const settings = recordingReader([row]);
    const subscription = recordingReader([{ slot: 1 }]);
    const pool = vi
      .spyOn(client, 'getDatabase')
      .mockReturnValueOnce(
        settings.sql as unknown as ReturnType<typeof client.getDatabase>,
      )
      .mockReturnValueOnce(
        subscription.sql as unknown as ReturnType<typeof client.getDatabase>,
      );
    expect(await readPlatformModelSettings()).toEqual({
      revision: row.revision,
      configuration: row.configuration,
      updatedAt: row.updated_at.toISOString(),
    });
    expect(await requireEnabledCodexSubscription()).toBe(1);
    expect(pool).toHaveBeenCalledTimes(2);
    expect(settings.query).toHaveBeenCalledTimes(1);
    expect(subscription.query).toHaveBeenCalledTimes(1);
  });
});
