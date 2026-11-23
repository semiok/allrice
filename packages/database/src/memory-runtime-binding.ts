/** @internal Memory-owned consumption seam, deliberately NOT in the database
 * barrel or EmployeeMemoryPort options. This is not another runtime factory or
 * a public SQL/transaction API. Workflow alone owns the outer caller lifecycle.
 *
 * A future original host composition must supply real module/config/current,
 * persistent B/call and human-source producers, with these reads bound to this
 * exact session and authority locks retained through its outer commit. Current
 * production producers are absent. Tests may mock this module with an explicit
 * same-transaction owner contract fixture; no fixture is installed here. */
import {
  ApplicationBuiltinModulesProjectionSchema,
  type ActualNativeCallSelectorProjection,
  type ActualNativeExecutionSelectorProjection,
  type AdoptedHumanSourceProjection,
  type CurrentEmployeeBusinessProjection,
  type EmployeeBusinessTargetProjection,
  type LogicalExecutionBindingProjection,
  type OriginalExecutionSelectorProjection,
  type RequestContext,
  type StoredHumanSourceSelectorProjection,
} from '@allrice/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';

/** Immutable original application version adopted for this memory execution.
 * Captured by Workflow's real owner; never copied from a later current read.
 * Unknown/unsealed original provenance cannot be reconstructed as a pin. */
export const MemoryRuntimeModuleOriginSchema = z
  .object({
    kind: z.literal('builtin'),
    moduleId: z.literal('employee-memory'),
    applicationBuild:
      ApplicationBuiltinModulesProjectionSchema.shape.applicationBuild.unwrap(),
  })
  .strict();

export interface MemoryRuntimeExecution {
  binding: LogicalExecutionBindingProjection;
  /** Immutable ORIGINAL owner/profile facts, never the current connection's
   * profile and never inferred from B, root pin or an untrusted selector. */
  nativeOwnerRef: string;
  nativeProfileRef: string;
  /** Actual authorized session/root relationship for this observation, also
   * available before there is any tool call. Not inferred from nativeCall=null. */
  nativeSessionRef: string;
  parentSessionRef: string | null;
  moduleConfigRevisionRef: string;
  moduleOrigin: z.infer<typeof MemoryRuntimeModuleOriginSchema>;
}
export interface MemoryRuntimeOwnerReads {
  /** Current authority locks precede memory-order. */
  current(): Promise<CurrentEmployeeBusinessProjection>;
  /** Actual/stored producers must reject an incomplete or unsupported restore
   * collection for an existing B. Missing context cannot mean a fresh root;
   * this caller never mints B or claims an independently consistent snapshot. */
  actual(
    input: ActualNativeExecutionSelectorProjection,
  ): Promise<MemoryRuntimeExecution>;
  stored(
    input: OriginalExecutionSelectorProjection,
  ): Promise<MemoryRuntimeExecution>;
  /** Human-source authority follows memory-order, consistently with original
   * pending-management transitions. Do not reverse the current/source locks. */
  adopted(
    input: ActualNativeCallSelectorProjection,
  ): Promise<AdoptedHumanSourceProjection>;
  storedSource(
    input: StoredHumanSourceSelectorProjection,
  ): Promise<AdoptedHumanSourceProjection>;
}
export interface MemoryRuntimeAssembly {
  /** Preflight must fail before opening a business transaction when a required
   * external producer is unavailable. This check alone is never a fence. */
  current(
    context: RequestContext,
    target: EmployeeBusinessTargetProjection,
    signal: AbortSignal,
  ): Promise<CurrentEmployeeBusinessProjection>;
  /** Package-private session parameter, not a frozen public assembly signature.
   * The returned named readers retain owner authority locks until outer commit;
   * neither the SQL handle nor any generic participation token is returned. */
  bind(
    tx: Sql | TransactionSql,
    context: RequestContext,
    target: EmployeeBusinessTargetProjection,
    signal: AbortSignal,
  ): Promise<MemoryRuntimeOwnerReads>;
}

export function readMemoryRuntimeAssembly(): MemoryRuntimeAssembly | null {
  return null;
}

export class MemoryRuntimeDependencyUnavailable extends Error {
  readonly code = 'memory_runtime_dependency_unavailable';
  constructor(readonly dependency: string) {
    super('memory_runtime_dependency_unavailable');
  }
}

export function requireMemoryRuntimeAssembly() {
  const assembly = readMemoryRuntimeAssembly();
  if (!assembly)
    throw new MemoryRuntimeDependencyUnavailable(
      'memory.current-module-execution-source-binding',
    );
  return assembly;
}
