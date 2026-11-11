import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmployeeMemoryRecord } from '@allrice/contracts';
import { employeeMemoryClient, memoryFull, memorySaveUnknown, memoryUnknown, type MemoryWriteStore } from './employee-memory-client';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = { scopeId: 'organization/workspace/viewer', workspaceId: id(1), instanceId: id(2), headers: {} };
const at = '2026-11-11T00:00:00.000Z';
const record: EmployeeMemoryRecord = { id: id(3), summary: '先写结论', details: '  保留原文\n\n第二段  ', hasDetails: true, state: 'pending', revision: 1, pairDigest: `sha256:${'a'.repeat(64)}`, capturedAt: at, updatedAt: at };
const pair = { summary: '先写结论', details: record.details };
const ack = (memory = { ...record, state: 'active' as const, revision: 2 }, status = 200) => Response.json({ schemaVersion: 2, memory, counts: { active: 1, pending: 0, maxActive: 100 } }, { status });
const denied = (status: number) => Response.json({ error: { code: 'AUTHORIZATION_DENIED', requestId: id(99), message: 'denied', retryable: false } }, { status });
const conflict = (reason: string, message = 'not a UI discriminator') => Response.json({ error: { code: 'CONFLICT', requestId: id(99), message, retryable: false, details: { domain: 'employee_memory', reason, ...(reason === 'memory_limit_reached' ? { counts: { active: 100, maxActive: 100 } } : {}) } } }, { status: 409 });
afterEach(() => vi.unstubAllGlobals());

describe('employee memory v2 consumer operation identity', () => {
  it('keeps a lost creation key through GET and later denial while allowing an explicitly different addition', async () => {
    const writes: MemoryWriteStore = new Map();
    const bodies: Array<Record<string, unknown>> = [];
    let attempt = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method !== 'POST') return Response.json({ schemaVersion: 2, workspaceId: id(1), instanceId: id(2), counts: { active: 0, pending: 0, maxActive: 100 }, active: [], pending: [] });
      bodies.push(JSON.parse(String(init.body)));
      attempt++;
      if (attempt === 1) throw Error('ack lost');
      if (attempt === 2) return denied(403);
      const submitted = bodies.at(-1)!;
      return ack({ ...record, summary: String(submitted.summary), details: submitted.details as string | null, hasDetails: submitted.details !== null, state: 'active', revision: 1 }, 201);
    }));
    const client = employeeMemoryClient(target, writes);
    await expect(client.save(pair, null)).rejects.toThrow(memorySaveUnknown);
    await client.list();
    await expect(client.save(pair, null)).rejects.toThrow();
    await client.save({ summary: '另一条明确的新记忆', details: null }, null);
    await client.save(pair, null);
    expect(bodies[0]?.idempotencyKey).toBe(bodies[1]?.idempotencyKey);
    expect(bodies[0]?.idempotencyKey).toBe(bodies[3]?.idempotencyKey);
    expect(bodies[2]?.idempotencyKey).not.toBe(bodies[0]?.idempotencyKey);
    expect(bodies[0]).toMatchObject({ ...pair, workspaceId: id(1), instanceId: id(2) });
    expect(writes.size).toBe(0);
  });

  it.each([401, 403, 404, 409])('retains original edit CAS after an unknown result followed by %s and a refreshed row', async (status) => {
    const writes: MemoryWriteStore = new Map();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) return new Response('{}', { status: 503 });
      if (bodies.length === 2) return status === 409 ? conflict('cas_conflict') : denied(status);
      return ack();
    }));
    const client = employeeMemoryClient(target, writes);
    await expect(client.save(pair, record)).rejects.toThrow(memorySaveUnknown);
    const refreshed = { ...record, revision: 4, pairDigest: `sha256:${'b'.repeat(64)}` };
    await expect(client.save(pair, refreshed)).rejects.toThrow();
    expect(writes.size).toBe(1);
    expect(JSON.stringify([...writes.values()])).not.toContain(pair.details);
    await client.save(pair, refreshed);
    expect(bodies).toEqual([bodies[0], bodies[0], bodies[0]]);
    expect(bodies[2]).toMatchObject({ expectedRevision: 1, pairDigest: record.pairDigest, details: record.details });
    expect(writes.size).toBe(0);
  });

  it('uses structured memory reason and never treats unrelated 409/message text as CAS', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(conflict('memory_limit_reached', 'cas_conflict'))
      .mockResolvedValueOnce(Response.json({ error: { code: 'CONFLICT', requestId: id(99), message: 'cas_conflict', retryable: false } }, { status: 409 }))
      .mockResolvedValueOnce(conflict('cas_conflict'));
    vi.stubGlobal('fetch', fetch);
    const client = employeeMemoryClient(target, new Map());
    await expect(client.confirm(record)).rejects.toThrow(memoryFull);
    await expect(client.confirm(record)).rejects.toThrow(memoryUnknown);
    await expect(client.confirm(record)).rejects.toThrow('记忆已变化，请重新读取后再操作。');
  });

  it('keeps nonempty details byte-for-byte, clears only with null, and rejects mismatched success receipts', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); bodies.push(body);
      if (bodies.length === 1) return ack({ ...record, id: id(8), state: 'active', revision: 2 });
      return ack({ ...record, details: body.details, hasDetails: body.details !== null, state: 'active', revision: Number(body.expectedRevision) + 1 });
    }));
    const client = employeeMemoryClient(target, new Map());
    await expect(client.save(pair, record)).rejects.toThrow(memorySaveUnknown);
    await client.save(pair, record);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]?.details).toBe(record.details);
    await client.save({ summary: record.summary, details: null }, { ...record, state: 'active', revision: 2, pairDigest: `sha256:${'b'.repeat(64)}` });
    expect(bodies[2]).toHaveProperty('details', null);
    expect(bodies[2]?.idempotencyKey).not.toBe(bodies[1]?.idempotencyKey);
    expect(bodies.every((body) => !('content' in body) && !('contentDigest' in body))).toBe(true);
  });

  it('isolates identical unknown requests by employee, viewer and tenant headers without retaining private text', async () => {
    const writes: MemoryWriteStore = new Map();
    const keys: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { keys.push(JSON.parse(String(init.body)).idempotencyKey); throw Error('network'); }));
    for (const scope of [target, { ...target, instanceId: id(9) }, { ...target, scopeId: 'another-viewer' }, { ...target, headers: { 'x-allrice-organization-id': id(10) } }])
      await expect(employeeMemoryClient(scope, writes).save(pair, null)).rejects.toThrow(memorySaveUnknown);
    expect(new Set(keys).size).toBe(4);
    await expect(employeeMemoryClient(target, writes).save(pair, null)).rejects.toThrow(memorySaveUnknown);
    expect(keys[4]).toBe(keys[0]);
    const stored = JSON.stringify([...writes]);
    expect(stored).not.toContain(pair.summary);
    expect(stored).not.toContain(pair.details);
    expect(stored).not.toContain('another-viewer');
  });
});
