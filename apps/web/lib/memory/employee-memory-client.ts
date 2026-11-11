import {
  ApiErrorSchema,
  EmployeeMemoryDetailResponseSchema,
  EmployeeMemoryListSchema,
  EmployeeMemoryMutationInputSchema,
  EmployeeMemoryWriteResponseSchema,
  PersonalMemoryPairSchema,
  type EmployeeMemoryRecord,
} from '@allrice/contracts';
import type { z } from 'zod';

export type MemoryRow = Omit<EmployeeMemoryRecord, 'details'>;
export type MemoryList = z.infer<typeof EmployeeMemoryListSchema>;
export type MemoryPair = z.infer<typeof PersonalMemoryPairSchema>;
export type MemoryTarget = {
  scopeId: string;
  workspaceId: string;
  instanceId: string;
  headers: Record<string, string>;
};
type Action = 'create' | 'edit' | 'promote' | 'delete';
type Identity = {
  fingerprint: string;
  key: string;
  uncertain: boolean;
  inFlight: number;
  cas?: { expectedRevision: number; pairDigest: string };
};
/** Page-owned, technical identity only. Never retain summary/details, credentials,
 * localStorage, or a module singleton across authenticated pages. */
export type MemoryWriteStore = Map<string, Identity>;
export const memoryUnknown = '暂时无法确认操作结果。';
export const memorySaveUnknown = '暂时无法确认保存结果。';
export const memoryReadFailed = '记忆读取失败，请重试。';
export const memoryFull =
  '记忆已满（100 / 100）。删掉不再用的记忆后，才能新增或确认新的。';

export class MemoryClientError extends Error {
  constructor(
    message: string,
    readonly definitive = false,
    readonly reason?: string,
  ) {
    super(message);
  }
}
export class MemoryAccessLost extends MemoryClientError {
  constructor() {
    super(memoryReadFailed, true);
  }
}

async function rejectResponse(response: Response): Promise<never> {
  if ([401, 403, 404].includes(response.status)) throw new MemoryAccessLost();
  const parsed = ApiErrorSchema.safeParse(
    await response.json().catch(() => null),
  );
  const error = parsed.success ? parsed.data.error : null;
  const details =
    response.status === 409 &&
    error?.code === 'CONFLICT' &&
    !error.retryable &&
    error.details?.domain === 'employee_memory'
      ? error.details
      : null;
  const definitive = Boolean(
    error &&
    !error.retryable &&
    response.status >= 400 &&
    response.status < 500,
  );
  throw new MemoryClientError(
    details?.reason === 'memory_limit_reached'
      ? memoryFull
      : details?.reason === 'cas_conflict'
        ? '记忆已变化，请重新读取后再操作。'
        : memoryUnknown,
    definitive,
    details?.reason,
  );
}

async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/** Requests bind the authenticated target at construction. A caller must discard
 * late results after scope changes; no response fabricates owner/scope echoes. */
export function employeeMemoryClient(
  target: MemoryTarget,
  writes: MemoryWriteStore,
) {
  const headers = { ...target.headers };
  const query = () =>
    new URLSearchParams({
      workspaceId: target.workspaceId,
      instanceId: target.instanceId,
    });
  const path = (id: string) => `/api/v1/memories/${encodeURIComponent(id)}`;
  async function read(url: string, signal?: AbortSignal) {
    const response = await fetch(url, {
      headers,
      cache: 'no-store',
      signal,
    });
    if ([401, 403, 404].includes(response.status)) throw new MemoryAccessLost();
    if (response.status !== 200) throw new Error(memoryReadFailed);
    return response.json();
  }
  async function detail(row: Pick<MemoryRow, 'id'>, signal?: AbortSignal) {
    const value = EmployeeMemoryDetailResponseSchema.parse(
      await read(path(row.id) + '?' + query(), signal),
    );
    if (value.memory.id !== row.id) throw Error(memoryReadFailed);
    return value.memory;
  }
  async function write(
    action: Action,
    row: MemoryRow | null,
    pair?: MemoryPair,
  ) {
    // The complete request signature identifies an intent, excluding CAS. If an
    // uncertain operation is explicitly retried after a refresh, both its key
    // AND original CAS survive. Explicitly changed content is a different
    // operation; it must not lock unrelated additions for this employee.
    const scope = await digest([
      target.scopeId,
      target.workspaceId,
      target.instanceId,
      Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)),
    ]);
    const fingerprint = await digest(pair ?? { pairDigest: row?.pairDigest });
    const slot = `${scope}/${action}/${row?.id ?? 'new'}/${fingerprint}`;
    let identity = writes.get(slot);
    if (!identity) {
      identity = {
        fingerprint,
        key: crypto.randomUUID(),
        uncertain: false,
        inFlight: 0,
        ...(row
          ? {
              cas: {
                expectedRevision: row.revision,
                pairDigest: row.pairDigest,
              },
            }
          : {}),
      };
      writes.set(slot, identity);
    }
    const operation = identity;
    const mutation = row
      ? EmployeeMemoryMutationInputSchema.parse({
          instanceId: target.instanceId,
          ...operation.cas,
          idempotencyKey: operation.key,
        })
      : null;
    const body =
      action === 'create'
        ? {
            workspaceId: target.workspaceId,
            instanceId: target.instanceId,
            idempotencyKey: operation.key,
            ...pair,
          }
        : action === 'edit'
          ? { ...mutation, ...pair, reason: '本人编辑' }
          : mutation;
    const url = row
      ? path(row.id) +
        (action === 'promote' ? '/promote' : '') +
        '?workspaceId=' +
        encodeURIComponent(target.workspaceId)
      : '/api/v1/memories';
    operation.inFlight += 1;
    try {
      const response = await fetch(url, {
        method:
          action === 'edit' ? 'PATCH' : action === 'delete' ? 'DELETE' : 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) await rejectResponse(response);
      if (action === 'delete') {
        if (response.status !== 204) throw new MemoryClientError(memoryUnknown);
        if (writes.get(slot) === operation) writes.delete(slot);
        return null;
      }
      if (response.status !== (action === 'create' ? 201 : 200))
        throw new MemoryClientError(memoryUnknown);
      const result = EmployeeMemoryWriteResponseSchema.parse(
        await response.json(),
      );
      if (
        result.memory.state !== 'active' ||
        (action === 'create' && result.memory.revision !== 1) ||
        (row && result.memory.id !== row.id) ||
        (operation.cas &&
          (action === 'edit'
            ? result.memory.revision !== operation.cas.expectedRevision + 1
            : result.memory.revision < operation.cas.expectedRevision ||
              result.memory.revision > operation.cas.expectedRevision + 1)) ||
        (action === 'promote' &&
          result.memory.pairDigest !== operation.cas?.pairDigest) ||
        (pair &&
          (result.memory.summary !== pair.summary ||
            result.memory.details !== pair.details))
      )
        throw new MemoryClientError(memoryUnknown);
      if (writes.get(slot) === operation) writes.delete(slot);
      return result;
    } catch (error) {
      if (error instanceof MemoryClientError && error.definitive) {
        // A later denial/conflict cannot disprove an earlier unknown outcome.
        if (
          !operation.uncertain &&
          operation.inFlight === 1 &&
          writes.get(slot) === operation
        )
          writes.delete(slot);
        throw error;
      }
      operation.uncertain = true;
      if (
        (action === 'create' || action === 'edit') &&
        (!(error instanceof MemoryClientError) ||
          error.message === memoryUnknown)
      )
        throw new MemoryClientError(memorySaveUnknown);
      throw error instanceof MemoryClientError
        ? error
        : new MemoryClientError(memoryUnknown);
    } finally {
      operation.inFlight -= 1;
    }
  }
  return {
    async list(signal?: AbortSignal) {
      const result = EmployeeMemoryListSchema.parse(
        await read('/api/v1/memories/manage?' + query(), signal),
      );
      if (
        result.workspaceId !== target.workspaceId ||
        result.instanceId !== target.instanceId
      )
        throw Error(memoryReadFailed);
      return result;
    },
    detail,
    save: (pair: MemoryPair, row: MemoryRow | null) =>
      write(row ? 'edit' : 'create', row, PersonalMemoryPairSchema.parse(pair)),
    confirm: (row: MemoryRow) => write('promote', row),
    remove: (row: MemoryRow) => write('delete', row),
  };
}
