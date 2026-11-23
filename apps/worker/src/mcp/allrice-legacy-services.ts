import {
  createLegacyEnterpriseMaterialsMcpPort,
  createLegacyEmployeeMemoryMcpPort,
  createLegacyDeliverablesMcpPort,
  type LegacyMcpExecution,
  type PreparedMcpDeliverable,
} from '@allrice/database';
import type { StoragePort } from '@allrice/contracts';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { generateDeliverable } from '../deliverable-generator.js';
import {
  allriceMcpApiError,
  type AllriceMcpDeliverableInput,
  type AllriceMcpScope,
  type AllriceMcpServices,
} from './allrice-server.js';

/** Gateway-provided association to a real legacy execution. Native instance,
 * profile, session, employee and call are host facts, not parsed MCP fields. */
export interface LegacyMcpCallAuthority extends LegacyMcpExecution {
  employeeInstanceId: string;
  nativeSessionRef: AllriceMcpScope['nativeSessionRef'];
  nativeCallRef: string;
  contentGenerationId?: string;
}

/** Minimal existing inline-generation path. Returning null means the native
 * Office/converter/proposal provider has not been bound, not that it failed
 * quality checks. No new format restriction or silent alternate generation. */
export async function prepareInlineMcpDeliverable(
  input: AllriceMcpDeliverableInput,
  signal: AbortSignal,
): Promise<PreparedMcpDeliverable | null> {
  if (
    input.content === undefined ||
    input.python ||
    input.officePdf ||
    input.location !== undefined ||
    input.artifactKind === 'changeset' ||
    !['markdown', 'text', 'html', 'json'].includes(input.format)
  )
    return null;
  signal.throwIfAborted();
  const generated = await generateDeliverable(
    input as AllriceMcpDeliverableInput & { content: string },
  );
  signal.throwIfAborted();
  let fileName = [...input.fileName]
    .map((character) =>
      '\\/:*?"<>|'.includes(character) || character.charCodeAt(0) < 32
        ? '-'
        : character,
    )
    .join('')
    .slice(0, 120);
  if (!fileName.toLowerCase().endsWith(generated.extension))
    fileName += generated.extension;
  return {
    kind: input.artifactKind ?? 'document',
    fileName,
    format: input.format,
    bytes: generated.bytes,
    mediaType: generated.mediaType,
    ...(input.parentObjectId ? { parentObjectId: input.parentObjectId } : {}),
    ...(input.changeSummary !== undefined
      ? { changeSummary: input.changeSummary }
      : {}),
  };
}

/** Explicit 3.x migration fixture/adapter. Its generation cannot satisfy a
 * 4.0 server: native receipt, memory pins/budget and publisher carriers must be
 * supplied by their 4.0 owners before production tools can be assembled. */
export function createLegacyAllriceMcpServices(options: {
  storage: StoragePort;
  resolveExecution(
    scope: AllriceMcpScope,
    signal: AbortSignal,
  ): Promise<LegacyMcpCallAuthority>;
  prepareDelivery?: (
    input: AllriceMcpDeliverableInput,
    authority: LegacyMcpCallAuthority,
    signal: AbortSignal,
  ) => Promise<PreparedMcpDeliverable | null>;
}): AllriceMcpServices {
  const references = createLegacyEnterpriseMaterialsMcpPort();
  const memory = createLegacyEmployeeMemoryMcpPort();
  const deliverables = createLegacyDeliverablesMcpPort(options.storage);
  async function authorized(scope: AllriceMcpScope, signal: AbortSignal) {
    signal.throwIfAborted();
    const authority = await options.resolveExecution(scope, signal);
    if (
      scope.executionGeneration !== '3.x' ||
      authority.executionGeneration !== '3.x' ||
      scope.personId !== authority.context.policySnapshot.subjectId ||
      scope.organizationId !== authority.context.organizationId ||
      scope.workspaceId !== authority.context.workspaceId ||
      scope.allriceThreadRef !== authority.sessionId ||
      scope.employeeInstanceId !== authority.employeeInstanceId ||
      scope.nativeCallRef !== authority.nativeCallRef ||
      scope.nativeSessionRef.instanceId !==
        authority.nativeSessionRef.instanceId ||
      scope.nativeSessionRef.profileId !==
        authority.nativeSessionRef.profileId ||
      scope.nativeSessionRef.sessionId !== authority.nativeSessionRef.sessionId
    )
      return null;
    signal.throwIfAborted();
    return authority;
  }
  async function run(
    scope: AllriceMcpScope,
    signal: AbortSignal,
    action: (authority: LegacyMcpCallAuthority) => Promise<CallToolResult>,
  ) {
    const authority = await authorized(scope, signal);
    return authority
      ? action(authority)
      : allriceMcpApiError(
          scope,
          'AUTHORIZATION_DENIED',
          'Current business access is unavailable.',
        );
  }
  return {
    executionGeneration: '3.x',
    referenceRead: (scope, input, signal) =>
      run(scope, signal, async (authority) => {
        if (!authority.contentGenerationId)
          return allriceMcpApiError(
            scope,
            'DEPENDENCY_UNAVAILABLE',
            'The reference execution carrier is not bound.',
          );
        const result = await references.readExact(
          {
            ...authority,
            contentGenerationId: authority.contentGenerationId,
            requestId: scope.requestContext.requestId,
          },
          input,
          signal,
        );
        if ('isError' in result) return result;
        return { content: [{ type: 'text', text: result.modelContent }] };
      }),
    memoryRead: (scope, input, signal) =>
      run(scope, signal, async (authority) => {
        // READOUT is the exact original rendered detail. No invented pin/hash
        // fields: the owner validates those against its actual issued ledger.
        const result = await memory.readOrdinal(
          { ...authority, requestId: scope.requestContext.requestId },
          input,
          signal,
        );
        return typeof result === 'string'
          ? { content: [{ type: 'text', text: result }] }
          : result;
      }),
    deliverableCreate: (scope, input, signal) =>
      run(scope, signal, async (authority) => {
        const prepared = options.prepareDelivery
          ? await options.prepareDelivery(input, authority, signal)
          : await prepareInlineMcpDeliverable(input, signal);
        if (!prepared)
          return allriceMcpApiError(
            scope,
            'DEPENDENCY_UNAVAILABLE',
            'The required delivery provider is not bound.',
          );
        const artifact = await deliverables.publishPrepared(
          {
            ...authority,
            callId: authority.nativeCallRef,
            requestId: scope.requestContext.requestId,
          },
          prepared,
          signal,
        );
        if ('isError' in artifact) return artifact;
        const result = {
          artifactId: artifact.id,
          digest: artifact.object.checksum,
          artifactKind: artifact.kind,
          objectId: artifact.object.id,
          fileName: artifact.version.fileName,
          mediaType: artifact.object.mediaType,
          sizeBytes: artifact.object.sizeBytes,
          seriesId: artifact.version.seriesId,
          version: artifact.version.version,
          parentObjectId: artifact.version.parentObjectId,
          changeSummary: artifact.version.changeSummary,
          downloadUrl: `/api/v1/files/${artifact.object.id}/download?name=${encodeURIComponent(artifact.version.fileName)}`,
          versionsUrl: `/api/v1/files/${artifact.object.id}/versions?workspaceId=${encodeURIComponent(scope.workspaceId!)}`,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }),
  };
}
