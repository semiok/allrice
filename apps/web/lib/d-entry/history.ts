import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ChecksumSchema,
  DEntrySelectionInputSchema,
  HostHistoryBindingSchema,
  HostHistoryPageSchema,
  UuidSchema,
  type HostHistoryAttachment,
  type HostHistoryBinding,
  type HostHistoryStorePort,
  type RequestContext,
  type StorageObject,
} from '@allrice/contracts';
import { DataAccessError, getStoredFile } from '@allrice/database';
import { HostHistoryIntegrityError, hostHistoryDigest } from '@allrice/storage';
import { requireRequestContext } from '../identity/session';
import { getStorageAdapter } from '../storage/runtime';
import { apiProblem } from '../api-error-response';
import { resolveDEntryIdentity } from './identity';
import {
  authorizeDEntryNativeResource,
  followDEntryNativeResource,
  type DEntryNativeResource,
  type DEntryNativeResourcePort,
} from './native-resource';
import { dEntryErrorResponse } from './responses';

const selection = DEntrySelectionInputSchema.extend({
  threadId: UuidSchema,
  nativeSessionId: z.string().min(1),
});
const pageInput = selection
  .extend({
    limit: z.coerce.number().int().positive().safe(),
    snapshotDigest: ChecksumSchema.optional(),
    afterSeq: z.coerce.number().int().min(-1).safe().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.afterSeq === undefined || input.snapshotDigest !== undefined,
  );
const attachmentInput = selection
  .extend({
    snapshotDigest: ChecksumSchema,
    objectId: UuidSchema,
  })
  .strict();

function query(request: Request) {
  const values = new Map<string, string>();
  for (const [key, value] of new URL(request.url).searchParams) {
    if (values.has(key)) throw new SyntaxError('Duplicate query');
    values.set(key, value);
  }
  return Object.fromEntries(values);
}

function matches(
  binding: HostHistoryBinding,
  resource: DEntryNativeResource,
  workspaceId: string,
) {
  return (
    binding.organizationId === resource.organizationId &&
    binding.personId === resource.personId &&
    binding.employeeInstanceId === resource.employeeInstanceId &&
    binding.workspaceId === workspaceId &&
    binding.threadId === resource.threadId &&
    binding.nativeSessionId === resource.nativeSessionId &&
    binding.rootNativeSessionId === resource.rootNativeSessionId &&
    binding.parentNativeSessionId === resource.parentNativeSessionId
  );
}

function exactObject(
  object: StorageObject,
  attachment: HostHistoryAttachment,
  binding: HostHistoryBinding,
) {
  if (
    object.id !== attachment.objectId ||
    object.organizationId !== binding.organizationId ||
    object.workspaceId !== binding.workspaceId ||
    object.checksum !== attachment.checksum ||
    object.sizeBytes !== attachment.sizeBytes ||
    object.mediaType !== attachment.mediaType ||
    !object.immutable ||
    object.deletedAt !== null
  )
    throw new DataAccessError('not_found');
}

function historyError(error: unknown) {
  if (error instanceof HostHistoryIntegrityError)
    return apiProblem({
      status: 409,
      code: 'CONFLICT',
      message: '历史记录完整性校验失败，无法读取此版本。',
      retryable: false,
    });
  return dEntryErrorResponse(error);
}

export interface DEntryHistoryPorts {
  /** Resolve only host-persisted root/catalog facts while cold: never wake a
   * VM, refresh model credentials, or call native resolveAgent for a read. */
  resources: DEntryNativeResourcePort;
  /** Current trusted host mapping. Return the recorded thread configuration;
   * never infer an instance/profile/release from browser selectors or env. */
  binding(
    resource: DEntryNativeResource,
    signal: AbortSignal,
  ): Promise<HostHistoryBinding>;
  store: HostHistoryStorePort;
  /** Production default authenticates the actual browser cookie. Test/host-only
   * composition may inject a trusted authenticator, never request JSON. */
  context?: typeof requireRequestContext;
  files?: {
    authorize(
      context: RequestContext,
      objectId: string,
      signal: AbortSignal,
    ): Promise<StorageObject>;
    open(
      object: StorageObject,
      signal: AbortSignal,
    ): Promise<ReadableStream<Uint8Array>>;
  };
}

/** Read-only BFF composition. It has no VM, model auth, Agent or execution port.
 * The native-route owner registers these handlers only after binding its real
 * resources/configuration/store. No placeholder route claims availability. */
export function createDEntryHistoryHandlers(ports: DEntryHistoryPorts) {
  const files = ports.files ?? {
    async authorize(
      context: RequestContext,
      objectId: string,
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      const file = await getStoredFile(context, objectId);
      signal.throwIfAborted();
      return file.object;
    },
    async open(object: StorageObject, signal: AbortSignal) {
      signal.throwIfAborted();
      return getStorageAdapter().get(object);
    },
  };
  async function read(
    request: Request,
    input: z.infer<typeof selection>,
    digest?: string,
  ) {
    const context = await (ports.context ?? requireRequestContext)(request);
    const identity = await resolveDEntryIdentity(
      context,
      {
        workspaceId: input.workspaceId,
        employeeInstanceId: input.employeeInstanceId,
        threadId: input.threadId,
      },
      'history',
    );
    const access = {
      context,
      identity,
      nativeSessionId: input.nativeSessionId,
      resources: ports.resources,
      signal: request.signal,
    };
    const resource = await authorizeDEntryNativeResource({
      ...access,
      effect: 'read',
    });
    const signal = AbortSignal.any([request.signal, resource.revoked]);
    const binding = HostHistoryBindingSchema.parse(
      await ports.binding(resource, signal),
    );
    if (!matches(binding, resource, identity.workspaceId))
      throw new DataAccessError('authorization_denied');
    const stored = await ports.store.read(binding, signal, digest);
    if (!stored) throw new DataAccessError('not_found');
    if (
      hostHistoryDigest(stored.snapshot) !== stored.digest ||
      hostHistoryDigest(stored.snapshot.binding) !== hostHistoryDigest(binding)
    )
      throw new HostHistoryIntegrityError();
    const current = await authorizeDEntryNativeResource({
      ...access,
      signal,
      effect: 'read',
    });
    if (
      current.bindingRef !== resource.bindingRef ||
      !matches(binding, current, identity.workspaceId)
    )
      throw new DataAccessError('authorization_denied');
    const currentBinding = HostHistoryBindingSchema.parse(
      await ports.binding(current, signal),
    );
    if (hostHistoryDigest(currentBinding) !== hostHistoryDigest(binding))
      throw new DataAccessError('authorization_denied');
    signal.throwIfAborted();
    return { context, access, resource, signal, binding, ...stored };
  }
  return {
    async history(request: Request) {
      try {
        const input = pageInput.parse(query(request));
        const stored = await read(request, input, input.snapshotDigest);
        const { snapshot, digest } = stored;
        const after = input.afterSeq ?? -1;
        if (after > snapshot.source.throughSeq)
          throw new HostHistoryIntegrityError();
        // Keep multiple native tool requests from one assistant event together.
        const remaining = snapshot.entries.filter((entry) => entry.seq > after);
        const positions = [
          ...new Set(remaining.map((entry) => entry.seq)),
        ].slice(0, input.limit);
        const end = positions.at(-1) ?? snapshot.source.throughSeq;
        const entries = remaining.filter((entry) => entry.seq <= end);
        const more = remaining.some((entry) => entry.seq > end);
        const source = {
          dshVersion: snapshot.source.dshVersion,
          sessionFormatVersion: snapshot.source.sessionFormatVersion,
          headerHash: snapshot.source.headerHash,
          inheritedEventCount: snapshot.source.inheritedEventCount,
          throughSeq: snapshot.source.throughSeq,
        };
        const last = snapshot.lastTurn;
        const unfinished =
          last.startSeq !== null &&
          (last.endSeq === null || last.startSeq > last.endSeq);
        const page = HostHistoryPageSchema.parse({
          schemaVersion: 1,
          snapshotDigest: digest,
          source,
          entries,
          attachments: snapshot.attachments.filter((attachment) =>
            entries.some(
              (entry) =>
                attachment.sourceSeq === entry.seq ||
                (entry.kind === 'tool' &&
                  entry.result?.seq === attachment.sourceSeq),
            ),
          ),
          nextCursor: more ? { snapshotDigest: digest, afterSeq: end } : null,
          notice: unfinished
            ? 'unfinished'
            : last.reason === 'interrupted'
              ? 'interrupted'
              : null,
          externalEffects: 'unverified',
        });
        stored.signal.throwIfAborted();
        return Response.json(page, {
          headers: {
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
          },
        });
      } catch (error) {
        return historyError(error);
      }
    },
    async download(request: Request) {
      try {
        const input = attachmentInput.parse(query(request));
        const stored = await read(request, input, input.snapshotDigest);
        const attachment = stored.snapshot.attachments.find(
          (item) => item.objectId === input.objectId,
        );
        if (!attachment) throw new DataAccessError('not_found');
        const object = await files.authorize(
          stored.context,
          attachment.objectId,
          stored.signal,
        );
        exactObject(object, attachment, stored.binding);
        const transfer = new AbortController();
        const chunks = followDEntryNativeResource(
          {
            ...stored.access,
            signal: AbortSignal.any([stored.signal, transfer.signal]),
          },
          async function* (resource, signal) {
            if (resource.bindingRef !== stored.resource.bindingRef)
              throw new DataAccessError('authorization_denied');
            const currentBinding = await ports.binding(resource, signal);
            if (
              hostHistoryDigest(currentBinding) !==
              hostHistoryDigest(stored.binding)
            )
              throw new DataAccessError('authorization_denied');
            const current = await files.authorize(
              stored.context,
              attachment.objectId,
              signal,
            );
            exactObject(current, attachment, stored.binding);
            const reader = (await files.open(current, signal)).getReader();
            const abort = () => {
              void reader.cancel(signal.reason).catch(() => undefined);
            };
            signal.addEventListener('abort', abort, { once: true });
            const hash = createHash('sha256');
            let size = 0;
            try {
              signal.throwIfAborted();
              while (true) {
                const next = await reader.read();
                signal.throwIfAborted();
                if (next.done) break;
                const authorized = await files.authorize(
                  stored.context,
                  attachment.objectId,
                  signal,
                );
                exactObject(authorized, attachment, stored.binding);
                const currentBinding = await ports.binding(resource, signal);
                if (
                  hostHistoryDigest(currentBinding) !==
                  hostHistoryDigest(stored.binding)
                )
                  throw new DataAccessError('authorization_denied');
                size += next.value.byteLength;
                if (size > attachment.sizeBytes)
                  throw new HostHistoryIntegrityError();
                hash.update(next.value);
                yield next.value;
              }
              if (
                size !== attachment.sizeBytes ||
                `sha256:${hash.digest('hex')}` !== attachment.checksum
              )
                throw new HostHistoryIntegrityError();
            } finally {
              signal.removeEventListener('abort', abort);
              await reader.cancel().catch(() => undefined);
              reader.releaseLock();
            }
          },
        );
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await chunks.next();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            } catch (error) {
              controller.error(error);
            }
          },
          async cancel() {
            transfer.abort();
            await chunks.return(undefined);
          },
        });
        return new Response(body, {
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(attachment.sizeBytes),
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
          },
        });
      } catch (error) {
        return historyError(error);
      }
    },
  };
}
