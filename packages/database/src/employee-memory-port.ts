import {
  CreatePersonalEmployeeMemoryInputSchema,
  EmployeeMemoryDetailResponseSchema,
  EmployeeMemoryListQuerySchema,
  EmployeeMemoryListSchema,
  EmployeeMemoryWriteResponseSchema,
  MemoryAdminDetailQueryProjectionSchema,
  MemoryAdminListQueryProjectionSchema,
  MemoryCorrectCommandProjectionSchema,
  MemoryDetailQueryProjectionSchema,
  MemoryMutationCommandProjectionSchema,
  type MemoryAdminDetailQueryProjection,
  type MemoryAdminListQueryProjection,
  type MemoryCorrectCommandProjection,
  type MemoryDetailQueryProjection,
  type MemoryMutationCommandProjection,
  type RequestContext,
} from '@allrice/contracts';
import type { z } from 'zod';
import { DataAccessError } from './data.ts';
import {
  getAdminEmployeeMemory,
  getPersonalEmployeeMemory,
  listAdminEmployeeMemories,
  listPersonalEmployeeMemories,
} from './employee-memory-management.ts';
import {
  correctManagedEmployeeMemory,
  createManagedEmployeeMemory,
  deleteManagedEmployeeMemory,
  promoteManagedEmployeeMemory,
} from './workspace/service.ts';

type ListQuery = z.input<typeof EmployeeMemoryListQuerySchema>;
type CreateCommand = z.input<typeof CreatePersonalEmployeeMemoryInputSchema>;
type ListResult = z.output<typeof EmployeeMemoryListSchema>;
type DetailResult = z.output<typeof EmployeeMemoryDetailResponseSchema>;
type WriteResult = z.output<typeof EmployeeMemoryWriteResponseSchema>;

/** Host assembly dependency for MET-273's current enterprise/employee module
 * qualification. It grants no resource or administrator authority. The reused
 * transaction still checks current principal/instance; those legacy internal
 * joins have not yet been replaced by the identity owner's public port.
 * Pre/post checks are not an atomic module-revocation transaction guarantee. */
export interface EmployeeMemoryModuleQualification {
  requireCurrentAccess(
    context: RequestContext,
    target: ListQuery,
    signal: AbortSignal,
  ): Promise<void>;
}

/** Implemented management slice of the approved EmployeeMemoryPort. Native
 * issued-context/readOrdinal/remember/source methods are absent until their
 * real dependencies are bound; no legacy Run or denial stub stands in for them. */
export interface EmployeeMemoryPort {
  list(
    context: RequestContext,
    input: ListQuery,
    signal: AbortSignal,
  ): Promise<ListResult>;
  detail(
    context: RequestContext,
    input: MemoryDetailQueryProjection,
    signal: AbortSignal,
  ): Promise<DetailResult>;
  create(
    context: RequestContext,
    input: CreateCommand,
    signal: AbortSignal,
  ): Promise<WriteResult>;
  correct(
    context: RequestContext,
    input: MemoryCorrectCommandProjection,
    signal: AbortSignal,
  ): Promise<WriteResult>;
  confirm(
    context: RequestContext,
    input: MemoryMutationCommandProjection,
    signal: AbortSignal,
  ): Promise<WriteResult>;
  withdraw(
    context: RequestContext,
    input: MemoryMutationCommandProjection,
    signal: AbortSignal,
  ): Promise<void>;
  listAdmin(
    context: RequestContext,
    input: MemoryAdminListQueryProjection,
    signal: AbortSignal,
  ): Promise<ListResult>;
  detailAdmin(
    context: RequestContext,
    input: MemoryAdminDetailQueryProjection,
    signal: AbortSignal,
  ): Promise<DetailResult>;
}

/** The owner write has completed, but its result was not delivered. Retain the
 * original operation key for reconciliation; this is not a definitive denial.
 * The ordinary Error maps through existing HTTP INTERNAL_ERROR (500), while
 * cause preserves the original validation/access/cancellation failure locally.
 * Native cancellation remains on the caller's unchanged AbortSignal. */
export class EmployeeMemoryWriteOutcomeUnknown extends Error {
  constructor(cause: unknown) {
    super('employee_memory_write_outcome_unknown', { cause });
    this.name = 'EmployeeMemoryWriteOutcomeUnknown';
  }
}

/** Await the actual owner transaction even when the caller has canceled. An
 * abort suppresses delivery; it cannot undo a committed operation receipt. */
async function joinOwner<T>(signal: AbortSignal, operation: () => Promise<T>) {
  signal.throwIfAborted();
  const result = await operation();
  signal.throwIfAborted();
  return result;
}

function writeResult(
  row: Awaited<ReturnType<typeof createManagedEmployeeMemory>>,
) {
  const { counts, ...memory } = row;
  return EmployeeMemoryWriteResponseSchema.parse({
    schemaVersion: 2,
    memory,
    counts,
  });
}

export function createEmployeeMemoryPort(
  options: { qualification?: EmployeeMemoryModuleQualification } = {},
): EmployeeMemoryPort {
  async function qualify(
    context: RequestContext,
    target: ListQuery,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const qualification = options.qualification;
    // There is no production MET-273 binding or implicit module-on default.
    if (!qualification) throw new DataAccessError('authorization_denied');
    const selected = {
      workspaceId: target.workspaceId,
      instanceId: target.instanceId,
    };
    await qualification.requireCurrentAccess(context, selected, signal);
    signal.throwIfAborted();
    return { qualification, selected };
  }

  async function employee<T>(
    context: RequestContext,
    target: ListQuery,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ) {
    const { qualification, selected } = await qualify(context, target, signal);
    const result = await joinOwner(signal, operation);
    await qualification.requireCurrentAccess(context, selected, signal);
    signal.throwIfAborted();
    return result;
  }

  async function write<T, R>(
    context: RequestContext,
    target: ListQuery,
    signal: AbortSignal,
    operation: () => Promise<T>,
    project: (value: T) => R,
  ) {
    const { qualification, selected } = await qualify(context, target, signal);
    // Input and admission failures above have no write effect. The owner's
    // transaction rejection keeps its existing rollback/domain-error contract.
    signal.throwIfAborted();
    const committed = await operation();
    try {
      signal.throwIfAborted();
      const result = project(committed);
      await qualification.requireCurrentAccess(context, selected, signal);
      signal.throwIfAborted();
      return result;
    } catch (cause) {
      // Neither a post-commit ZodError nor a revoked/canceled delivery can
      // prove that no write occurred. Do not expose the now-unauthorized result.
      throw new EmployeeMemoryWriteOutcomeUnknown(cause);
    }
  }

  return {
    async list(context, input, signal) {
      const query = EmployeeMemoryListQuerySchema.parse(input);
      return employee(context, query, signal, async () =>
        EmployeeMemoryListSchema.parse(
          await listPersonalEmployeeMemories(
            context,
            query.workspaceId,
            query.instanceId,
          ),
        ),
      );
    },
    async detail(context, input, signal) {
      const query = MemoryDetailQueryProjectionSchema.parse(input);
      return employee(context, query, signal, async () =>
        EmployeeMemoryDetailResponseSchema.parse(
          await getPersonalEmployeeMemory(
            context,
            query.workspaceId,
            query.instanceId,
            query.memoryId,
          ),
        ),
      );
    },
    async create(context, input, signal) {
      const command = CreatePersonalEmployeeMemoryInputSchema.parse(input);
      return write(
        context,
        command,
        signal,
        () => createManagedEmployeeMemory(context, command),
        writeResult,
      );
    },
    async correct(context, input, signal) {
      const command = MemoryCorrectCommandProjectionSchema.parse(input);
      return write(
        context,
        {
          workspaceId: command.target.workspaceId,
          instanceId: command.body.instanceId,
        },
        signal,
        () =>
          correctManagedEmployeeMemory(
            context,
            command.target.workspaceId,
            command.target.memoryId,
            command.body,
          ),
        writeResult,
      );
    },
    async confirm(context, input, signal) {
      const command = MemoryMutationCommandProjectionSchema.parse(input);
      return write(
        context,
        {
          workspaceId: command.target.workspaceId,
          instanceId: command.body.instanceId,
        },
        signal,
        () =>
          promoteManagedEmployeeMemory(
            context,
            command.target.workspaceId,
            command.target.memoryId,
            command.body,
          ),
        writeResult,
      );
    },
    async withdraw(context, input, signal) {
      const command = MemoryMutationCommandProjectionSchema.parse(input);
      return write(
        context,
        {
          workspaceId: command.target.workspaceId,
          instanceId: command.body.instanceId,
        },
        signal,
        () =>
          deleteManagedEmployeeMemory(
            context,
            command.target.workspaceId,
            command.target.memoryId,
            command.body,
          ),
        () => undefined,
      );
    },
    async listAdmin(context, input, signal) {
      const query = MemoryAdminListQueryProjectionSchema.parse(input);
      // Employee module qualification is separate from real admin inspection.
      return joinOwner(signal, async () =>
        EmployeeMemoryListSchema.parse(
          await listAdminEmployeeMemories(
            context,
            query.organizationId,
            query.ownerId,
            query.instanceId,
          ),
        ),
      );
    },
    async detailAdmin(context, input, signal) {
      const query = MemoryAdminDetailQueryProjectionSchema.parse(input);
      return joinOwner(signal, async () =>
        EmployeeMemoryDetailResponseSchema.parse(
          await getAdminEmployeeMemory(
            context,
            query.organizationId,
            query.ownerId,
            query.instanceId,
            query.memoryId,
          ),
        ),
      );
    },
  };
}
