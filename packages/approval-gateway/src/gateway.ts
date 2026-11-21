import { createHash, randomUUID } from 'node:crypto';
import type { RequestContext } from '@allrice/contracts';
import {
  ApprovalError,
  ApprovalRefSchema,
  ApprovalStageSchema,
  ApprovalDecisionSchema,
  ApprovalAttachmentSchema,
  type ApprovalBinding,
  type ApprovalOptions,
  type ApprovalRecord,
  type ApprovalRef,
  type ApprovalView,
  type ExternalReceipt,
  type FrozenPayload,
} from './contract.js';

function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  throw new ApprovalError('INVALID_INPUT');
}
export const approvalDigest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
const deny = () => {
  throw new ApprovalError('DENIED');
};
function scope(binding: ApprovalBinding) {
  return [
    binding.vm,
    binding.workspaceId,
    binding.employeeInstanceId,
    binding.employeeRelease,
    binding.allriceThreadRef,
    binding.executionGeneration,
    binding.native.instanceId,
    binding.native.profile,
    binding.native.rootSessionId,
  ];
}
export function approvalView(record: ApprovalRecord): ApprovalView {
  return clone({
    ref: record.ref,
    adapterId: record.payload.adapterId,
    actionLabel: record.payload.actionLabel,
    target: record.payload.target,
    body: record.payload.body,
    attachments: record.payload.attachments.map((file) => ({
      selection: file.selection,
      filename: file.filename,
      mediaType: file.mediaType,
      size: file.size,
      sha256: file.sha256,
    })),
    decision: record.decision,
    revoked: record.revoked,
    effect: record.receipt
      ? 'received'
      : record.intentAt
        ? 'unknown'
        : 'not-dispatched',
    receipt: record.receipt,
    failure: record.failure,
  });
}
export function assertApprovalRef(record: ApprovalRecord, ref: ApprovalRef) {
  if (
    record.ref.requestId !== ref.requestId ||
    record.ref.version !== ref.version ||
    record.ref.digest !== ref.digest
  )
    throw new ApprovalError('CONFLICT');
}
function verify(record: ApprovalRecord) {
  if (
    approvalDigest([scope(record.binding), record.payload]) !==
    record.ref.digest
  )
    throw new ApprovalError('INTEGRITY');
  for (const file of record.payload.attachments) {
    const bytes = Buffer.from(file.base64, 'base64');
    if (
      bytes.toString('base64') !== file.base64 ||
      bytes.length !== file.size ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    )
      throw new ApprovalError('INTEGRITY');
  }
}
function validateReceipt(receipt: ExternalReceipt, ref: ApprovalRef) {
  if (
    !receipt ||
    typeof receipt.id !== 'string' ||
    !receipt.id ||
    receipt.digest !== ref.digest
  )
    throw new ApprovalError('INTEGRITY');
}
/** No identity, destination, resource or permission defaults. All are host-owned ports. */
export function createApprovalGateway(options: ApprovalOptions) {
  const { store, authority, policy } = options;
  for (const value of [
    policy.maxRequestBytes,
    policy.maxBodyBytes,
    policy.maxAttachmentBytes,
    policy.maxAttachments,
  ])
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new ApprovalError('INVALID_INPUT');
  const destination = (id: string) =>
    Object.hasOwn(options.destinations, id)
      ? options.destinations[id]!
      : deny();
  const resource = (id: string) =>
    Object.hasOwn(options.resources, id) ? options.resources[id]! : deny();
  async function load(input: unknown) {
    const ref = ApprovalRefSchema.parse(input);
    const record = await store.get(ref.requestId);
    if (!record) return deny();
    return { record, ref };
  }
  async function rights(
    binding: ApprovalBinding,
    payload: FrozenPayload,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    await destination(payload.adapterId).assertCurrent(
      binding,
      clone(payload.target),
      signal,
    );
    for (const attachment of payload.attachments)
      await resource(attachment.selection.module).assertCurrent(
        binding,
        clone(attachment.selection),
        signal,
      );
    signal.throwIfAborted();
  }
  async function forUser(
    context: RequestContext,
    input: unknown,
    signal: AbortSignal,
  ) {
    const { record, ref } = await load(input);
    if (
      context.actor.type !== 'user' ||
      context.actor.id !== record.binding.vm.personId ||
      context.organizationId !== record.binding.vm.organizationId ||
      context.workspaceId !== record.binding.workspaceId
    )
      return deny();
    await authority.assertUser(context, clone(record.binding), signal);
    assertApprovalRef(record, ref);
    verify(record);
    await rights(record.binding, record.payload, signal);
    return record;
  }
  async function forCall(
    binding: ApprovalBinding,
    input: unknown,
    signal: AbortSignal,
  ) {
    await authority.assertCall(binding, signal);
    const { record, ref } = await load(input);
    if (
      approvalDigest(scope(record.binding)) !== approvalDigest(scope(binding))
    )
      return deny();
    assertApprovalRef(record, ref);
    verify(record);
    await rights(binding, record.payload, signal);
    return record;
  }
  return {
    async stage(
      bindingInput: ApprovalBinding,
      input: unknown,
      signal: AbortSignal,
    ) {
      const binding = clone(bindingInput),
        request = ApprovalStageSchema.parse(input);
      if (
        Buffer.byteLength(JSON.stringify(request)) > policy.maxRequestBytes ||
        Buffer.byteLength(request.body) > policy.maxBodyBytes ||
        request.attachments.length > policy.maxAttachments
      )
        throw new ApprovalError('LIMIT_EXCEEDED');
      await authority.assertCall(binding, signal);
      const adapter = destination(request.adapterId);
      const actionLabel = adapter.actionLabel;
      if (typeof actionLabel !== 'string' || !actionLabel.trim())
        throw new ApprovalError('INVALID_INPUT');
      const target = await adapter.resolve(binding, request.target, signal);
      if (!target.id || !target.label) throw new ApprovalError('INVALID_INPUT');
      const attachments: FrozenPayload['attachments'][number][] = [];
      let remaining = policy.maxAttachmentBytes;
      const seen = new Set<string>();
      for (const selection of request.attachments) {
        if (seen.has(approvalDigest(selection)))
          throw new ApprovalError('INVALID_INPUT');
        seen.add(approvalDigest(selection));
        const snapshot = await resource(selection.module).snapshot(
          binding,
          clone(selection),
          remaining,
          signal,
        );
        if (
          !snapshot.ref ||
          !snapshot.filename ||
          !snapshot.mediaType ||
          snapshot.bytes.byteLength > remaining
        )
          throw new ApprovalError('LIMIT_EXCEEDED');
        const bytes = Buffer.from(snapshot.bytes);
        remaining -= bytes.length;
        attachments.push({
          selection: { module: selection.module, ref: snapshot.ref },
          filename: snapshot.filename,
          mediaType: snapshot.mediaType,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          base64: bytes.toString('base64'),
        });
      }
      const payload: FrozenPayload = {
        adapterId: request.adapterId,
        actionLabel,
        target: clone(target),
        body: request.body,
        attachments,
      };
      await authority.assertCall(binding, signal);
      await rights(binding, payload, signal);
      const record: ApprovalRecord = {
        ref: {
          requestId: randomUUID(),
          version: 1,
          digest: approvalDigest([scope(binding), payload]),
        },
        scopeKey: approvalDigest([
          binding.vm.organizationId,
          binding.vm.personId,
          binding.workspaceId,
          binding.employeeInstanceId,
          request.adapterId,
        ]),
        idempotencyKey: request.idempotencyKey,
        binding,
        payload,
        decision: 'pending',
        decidedBy: null,
        decidedAt: null,
        revoked: false,
        intentAt: null,
        receipt: null,
        failure: null,
      };
      return approvalView(await store.stage(record));
    },
    async view(context: RequestContext, ref: unknown, signal: AbortSignal) {
      return approvalView(await forUser(context, ref, signal));
    },
    async status(binding: ApprovalBinding, ref: unknown, signal: AbortSignal) {
      return approvalView(await forCall(clone(binding), ref, signal));
    },
    async attachment(
      context: RequestContext,
      input: unknown,
      signal: AbortSignal,
    ) {
      const { index, ...ref } = ApprovalAttachmentSchema.parse(input);
      const record = await forUser(context, ref, signal);
      const file = record.payload.attachments[index];
      if (!file) return deny();
      return {
        filename: file.filename,
        bytes: Buffer.from(file.base64, 'base64'),
      };
    },
    async decide(context: RequestContext, input: unknown, signal: AbortSignal) {
      const { decision, ...ref } = ApprovalDecisionSchema.parse(input);
      const record = await forUser(context, ref, signal);
      return approvalView(
        await store.decide(record.ref, context.actor.id, decision),
      );
    },
    async revoke(context: RequestContext, ref: unknown, signal: AbortSignal) {
      const record = await forUser(context, ref, signal);
      return approvalView(await store.revoke(record.ref));
    },
    async execute(
      bindingInput: ApprovalBinding,
      ref: unknown,
      signal: AbortSignal,
    ) {
      const binding = clone(bindingInput),
        record = await forCall(binding, ref, signal);
      return authority.admit(
        binding,
        async (admissionSignal) => {
          const effectSignal = AbortSignal.any([signal, admissionSignal]);
          await authority.assertCall(binding, effectSignal);
          await rights(binding, record.payload, effectSignal);
          const claim = await store.claim(record.ref);
          if (!claim.claimed) return approvalView(claim.record);
          // Durable intent is never cleared, even if abort happens before bytes leave this process.
          let phase: 'dispatch' | 'verify' | 'persist' = 'dispatch';
          try {
            effectSignal.throwIfAborted();
            const receipt = await destination(
              record.payload.adapterId,
            ).dispatch(
              clone(binding),
              clone(record.ref),
              clone(record.payload),
              effectSignal,
            );
            phase = 'verify';
            validateReceipt(receipt, record.ref);
            phase = 'persist';
            return approvalView(await store.receive(record.ref, receipt));
          } catch (error) {
            // Keep the first safe failure fact without copying secrets or external error messages.
            const kind =
              phase === 'verify'
                ? 'RECEIPT_INTEGRITY'
                : phase === 'persist'
                  ? 'RECEIPT_PERSIST_FAILED'
                  : effectSignal.aborted
                    ? 'CANCELLED'
                    : 'DISPATCH_FAILED';
            try {
              return approvalView(
                await store.noteFailure(record.ref, {
                  kind,
                  code: error instanceof ApprovalError ? error.code : null,
                }),
              );
            } catch {
              // Intent remains durable. A broken ledger is an error, never a manufactured success.
              throw new ApprovalError('UNAVAILABLE');
            }
          }
        },
        signal,
      );
    },
    async reconcile(
      context: RequestContext,
      ref: unknown,
      signal: AbortSignal,
    ) {
      const record = await forUser(context, ref, signal);
      if (!record.intentAt || record.receipt) return approvalView(record);
      const receipt = await destination(record.payload.adapterId).lookup(
        clone(record.binding),
        clone(record.ref),
        clone(record.payload),
        signal,
      );
      if (!receipt) return approvalView(record);
      validateReceipt(receipt, record.ref);
      return approvalView(await store.receive(record.ref, receipt));
    },
  };
}
export type ApprovalGateway = ReturnType<typeof createApprovalGateway>;
