import { randomUUID } from 'node:crypto';
import type { RequestContext } from '@allrice/contracts';
import {
  ApprovalError,
  type ApprovalBinding,
  type ApprovalStore,
  type ApprovalRecord,
  type ApprovalRef,
  type ExternalReceipt,
  type FrozenPayload,
} from './contract.js';
import { assertApprovalRef, createApprovalGateway } from './gateway.js';

/** Test-only owner/receiver; never exported by this package. */
export function memoryStore(): ApprovalStore {
  const rows = new Map<string, ApprovalRecord>();
  const copy = <T>(x: T): T => structuredClone(x);
  const row = (ref: ApprovalRef) => {
    const value = rows.get(ref.requestId);
    if (!value) throw new ApprovalError('DENIED');
    assertApprovalRef(value, ref);
    return value;
  };
  const set = (r: ApprovalRecord) => {
    rows.set(r.ref.requestId, copy(r));
    return copy(r);
  };
  return {
    async stage(r) {
      const old = [...rows.values()].find(
        (x) =>
          x.scopeKey === r.scopeKey && x.idempotencyKey === r.idempotencyKey,
      );
      if (old && old.ref.digest !== r.ref.digest)
        throw new ApprovalError('CONFLICT');
      return old ? copy(old) : set(r);
    },
    async get(id) {
      return rows.has(id) ? copy(rows.get(id)!) : null;
    },
    async decide(ref, actorId, decision) {
      const r = row(ref);
      if (r.revoked) throw new ApprovalError('REVOKED');
      if (r.intentAt || (r.decision !== 'pending' && r.decision !== decision))
        throw new ApprovalError('CONFLICT');
      return r.decision === decision
        ? copy(r)
        : set({
            ...r,
            decision,
            decidedBy: actorId,
            decidedAt: new Date().toISOString(),
          });
    },
    async revoke(ref) {
      const r = row(ref);
      if (r.intentAt) throw new ApprovalError('CONFLICT');
      return set({ ...r, revoked: true });
    },
    async claim(ref) {
      const r = row(ref);
      if (r.revoked) throw new ApprovalError('REVOKED');
      if (r.decision !== 'approved') throw new ApprovalError('NOT_CONFIRMED');
      if (r.intentAt) return { claimed: false, record: copy(r) };
      return {
        claimed: true,
        record: set({ ...r, intentAt: new Date().toISOString() }),
      };
    },
    async noteFailure(ref, failure) {
      const r = row(ref);
      if (!r.intentAt) throw new ApprovalError('CONFLICT');
      return r.failure
        ? copy(r)
        : set({ ...r, failure: { ...failure, at: new Date().toISOString() } });
    },
    async receive(ref, receipt) {
      const r = row(ref);
      if (
        !r.intentAt ||
        receipt.digest !== ref.digest ||
        (r.receipt && r.receipt.id !== receipt.id)
      )
        throw new ApprovalError('CONFLICT');
      return set({ ...r, receipt });
    },
  };
}
export function fixture(store: ApprovalStore = memoryStore()) {
  const person = randomUUID(),
    organization = randomUUID();
  const binding: ApprovalBinding = {
    vm: {
      vmId: randomUUID(),
      personId: person,
      organizationId: organization,
      instanceId: randomUUID(),
      leaseEpoch: 1,
    },
    workspaceId: randomUUID(),
    employeeInstanceId: randomUUID(),
    employeeRelease: 'fixture-release',
    allriceThreadRef: randomUUID(),
    runId: randomUUID(),
    executionId: randomUUID(),
    executionGeneration: '4.0',
    native: {
      instanceId: randomUUID(),
      profile: 'fixture',
      sessionId: 'root',
      rootSessionId: 'root',
      parentSessionId: null,
      callId: randomUUID(),
    },
  };
  const context: RequestContext = {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    actor: { type: 'user', id: person },
    organizationId: organization,
    workspaceId: binding.workspaceId,
    memberships: [],
    authenticatedAt: new Date().toISOString(),
  };
  let permitted = true,
    source = Buffer.from('frozen source'),
    loseAck = false,
    lookupKnown = true;
  const accepted = new Map<
    string,
    { payload: FrozenPayload; receipt: ExternalReceipt }
  >();
  let dispatches = 0;
  const check = async () => {
    if (!permitted) throw new ApprovalError('DENIED');
  };
  const options = {
    store,
    policy: {
      maxRequestBytes: 10000,
      maxBodyBytes: 5000,
      maxAttachmentBytes: 10000,
      maxAttachments: 4,
    },
    authority: {
      assertCall: check,
      assertUser: check,
      admit: async <T>(
        _b: ApprovalBinding,
        cb: (signal: AbortSignal) => Promise<T>,
        signal: AbortSignal,
      ) => {
        await check();
        return cb(signal);
      },
    },
    resources: {
      files: {
        snapshot: async () => ({
          ref: 'revision:1',
          filename: 'report.txt',
          mediaType: 'text/plain',
          bytes: source,
        }),
        assertCurrent: check,
      },
    },
    destinations: {
      inbox: {
        actionLabel: '发送到合成接收器',
        resolve: async () => ({ id: 'synthetic:inbox', label: '合成接收器' }),
        assertCurrent: check,
        dispatch: async (
          _binding: ApprovalBinding,
          ref: ApprovalRef,
          payload: FrozenPayload,
        ) => {
          dispatches++;
          const receipt = {
            id: 'receipt:' + ref.requestId,
            digest: ref.digest,
          };
          accepted.set(ref.requestId, {
            payload: structuredClone(payload),
            receipt,
          });
          if (loseAck) throw Error('committed before ACK');
          return receipt;
        },
        lookup: async (_binding: ApprovalBinding, ref: ApprovalRef) =>
          lookupKnown ? (accepted.get(ref.requestId)?.receipt ?? null) : null,
      },
    },
  };
  return {
    store,
    options,
    binding,
    context,
    accepted,
    gateway: createApprovalGateway(options),
    input: {
      idempotencyKey: randomUUID(),
      adapterId: 'inbox',
      target: 'inbox',
      body: '请把这个报告交给收件人',
      attachments: [{ module: 'files', ref: 'revision:1' }],
    },
    setPermitted(value: boolean) {
      permitted = value;
    },
    setSource(value: string) {
      source = Buffer.from(value);
    },
    loseAck() {
      loseAck = true;
    },
    hideReceipt() {
      lookupKnown = false;
    },
    get dispatches() {
      return dispatches;
    },
  };
}
