/** Memory-owned thin callbacks for the formal 272 public service surface.
 * These adapt the existing business port; they create no runtime factory,
 * SQL transaction, B/call association or production producer registration. */
import type { EmployeeMemoryPort } from '@allrice/database';
import {
  createEmployeeMemoryPort,
  EmployeeMemoryWriteOutcomeUnknown,
} from '@allrice/database';
import { readDEntryBusinessIdentity } from '../business-runtime/d-entry-current.ts';
import {
  denyBusinessProjection,
  EmployeeBusinessRuntimeError,
} from '../business-runtime/contract.ts';
import type {
  AllriceMcpMemoryRead,
  AllriceMcpMemoryRemember,
  AllriceMcpScope,
  AllriceMcpServices,
} from './allrice-server.ts';

type Target = Parameters<EmployeeMemoryPort['readOrdinal']>[1];
type NativePort = Pick<EmployeeMemoryPort, 'readOrdinal' | 'remember'>;
/** Only an actual host/native observation reader may supply this target. It
 * must resolve the current request to the original B/call through its owner;
 * raw nativeCallRef is an opaque selector, never parsed or used as authority. */
export interface EmployeeMemoryNativeTargets {
  actual(scope: AllriceMcpScope, signal: AbortSignal): Promise<Target>;
}

export function bindEmployeeMemoryMcpServices(
  options: {
    port?: NativePort;
    targets?: EmployeeMemoryNativeTargets;
  } = {},
): Pick<
  AllriceMcpServices,
  'executionGeneration' | 'memoryRead' | 'memoryRemember'
> {
  const port = options.port ?? createEmployeeMemoryPort();
  async function target(scope: AllriceMcpScope, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!options.targets)
      throw new EmployeeBusinessRuntimeError(
        'business_runtime_dependency_unavailable',
        'memory.native-target',
      );
    const context = scope.requestContext;
    if (
      scope.executionGeneration !== '4.0' ||
      !scope.workspaceId ||
      context.actor.type !== 'user' ||
      context.actor.id.toLowerCase() !== scope.personId.toLowerCase() ||
      context.organizationId.toLowerCase() !==
        scope.organizationId.toLowerCase() ||
      (context.workspaceId !== null &&
        context.workspaceId.toLowerCase() !== scope.workspaceId.toLowerCase())
    )
      denyBusinessProjection('memory.identity');
    const selected = await options.targets.actual(scope, signal);
    signal.throwIfAborted();
    if (
      selected.workspaceId.toLowerCase() !== scope.workspaceId.toLowerCase() ||
      selected.employeeInstanceId.toLowerCase() !==
        scope.employeeInstanceId.toLowerCase() ||
      selected.threadId.toLowerCase() !==
        scope.allriceThreadRef.toLowerCase() ||
      selected.moduleRelease.moduleId !== 'employee-memory'
    )
      denyBusinessProjection('memory.native-target');
    // The default identity reader is the real 271 public implementation; no
    // enabled_modules, history fallback or write-on-read hub mapping is used.
    await readDEntryBusinessIdentity(
      context,
      {
        workspaceId: selected.workspaceId,
        employeeInstanceId: selected.employeeInstanceId,
        threadId: selected.threadId,
      },
      'execute',
      signal,
    );
    signal.throwIfAborted();
    return selected;
  }
  const memoryRead: AllriceMcpMemoryRead = async (scope, input, signal) => {
    const selected = await target(scope, signal);
    const text = await port.readOrdinal(
      scope.requestContext,
      selected,
      input,
      signal,
    );
    signal.throwIfAborted();
    return { content: [{ type: 'text', text }] };
  };
  const memoryRemember: AllriceMcpMemoryRemember = async (
    scope,
    input,
    signal,
  ) => {
    const selected = await target(scope, signal);
    const receipt = await port.remember(
      scope.requestContext,
      selected,
      input,
      signal,
    );
    try {
      signal.throwIfAborted();
    } catch (cause) {
      throw new EmployeeMemoryWriteOutcomeUnknown(cause);
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            id: receipt.id,
            summary: receipt.summary,
            memoryClass: receipt.memoryClass,
            state: receipt.state,
            requiresConfirmation: receipt.requiresConfirmation,
          }),
        },
      ],
    };
  };
  return { executionGeneration: '4.0', memoryRead, memoryRemember };
}
