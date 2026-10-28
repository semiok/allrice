import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { JobCompletionGuard } from '@allrice/database';
import { HandlerError } from '../errors.js';
import type { FinalDeliveryProof } from './guard.js';

type CommitBinding = Readonly<{
  proof: FinalDeliveryProof;
  guard: JobCompletionGuard;
  assertCurrent: JobCompletionGuard['assertCurrent'];
}>;
const commitGuards = new WeakMap<object, CommitBinding>();

type Entry = Readonly<{
  answer: string;
  proof: FinalDeliveryProof;
  commit?: CommitBinding;
}>;

// Worker-private bookkeeping. No symbol/property is attached to the carrier,
// so spread/JSON/clone/event serialization cannot manufacture or expose it.
const deliveries = new WeakMap<object, Entry>();
type ExecutionCoverage = {
  required: boolean;
  output?: object;
  entry?: Entry;
};
const executions = new WeakMap<object, ExecutionCoverage>();

/** Private per-invocation result, never a serializable Job/result property. */
export type CheckedFinalDeliveryCoverage =
  | Readonly<{ coverage: 'uncovered' }>
  | Readonly<{
      coverage: 'checked_native_v1';
      proof: FinalDeliveryProof;
      checkedDelivery: JobCompletionGuard;
    }>;
const fields = [
  'nativeSessionId',
  'publicMessageId',
  'durableSeq',
  'nativeBindingId',
  'nativeCandidateDigest',
  'candidateDigest',
  'factSetDigest',
  'attempt',
  'generation',
] as const satisfies readonly (keyof FinalDeliveryProof)[];
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function unavailable(): never {
  throw new HandlerError(
    'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
    '交付回执与最终答复尚不能确认；已有内容已保留，未自动重跑任务。',
    false,
  );
}

function object(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !types.isProxy(value);
}

function plain(value: unknown): value is object {
  if (!object(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function answer(value: unknown): string {
  if (!plain(value)) unavailable();
  // Do not execute a getter, toJSON or Proxy trap to check a receipt.
  const descriptor = Object.getOwnPropertyDescriptor(value, 'answer');
  if (
    !descriptor ||
    !('value' in descriptor) ||
    typeof descriptor.value !== 'string' ||
    !descriptor.value.trim()
  )
    unavailable();
  return descriptor.value;
}

function digest(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function snapshot(value: FinalDeliveryProof): FinalDeliveryProof {
  if (!plain(value)) unavailable();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length) unavailable();
  const data: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) unavailable();
    data[key] = descriptor.value;
  }
  const text = (key: keyof FinalDeliveryProof): string => {
    const result = data[key];
    if (typeof result !== 'string' || !result.trim()) unavailable();
    return result;
  };
  const integer = (key: keyof FinalDeliveryProof, minimum: number): number => {
    const result = data[key];
    if (
      typeof result !== 'number' ||
      !Number.isSafeInteger(result) ||
      result < minimum
    )
      unavailable();
    return result;
  };
  const nativeCandidateDigest = text('nativeCandidateDigest');
  const candidateDigest = text('candidateDigest');
  const factSetDigest = text('factSetDigest');
  if (
    !SHA256.test(nativeCandidateDigest) ||
    !SHA256.test(candidateDigest) ||
    !SHA256.test(factSetDigest)
  )
    unavailable();
  return Object.freeze({
    nativeSessionId: text('nativeSessionId'),
    publicMessageId: text('publicMessageId'),
    durableSeq: integer('durableSeq', 0),
    nativeBindingId: text('nativeBindingId'),
    nativeCandidateDigest,
    candidateDigest,
    factSetDigest,
    attempt: integer('attempt', 1),
    generation: integer('generation', 0),
  });
}

function assertAnswer(value: unknown, entry: Entry): void {
  if (entry.commit) assertCommit(entry.commit);
  const current = answer(value);
  if (
    current !== entry.answer ||
    digest(current) !== entry.proof.candidateDigest
  )
    unavailable();
}

function assertCommit(binding: CommitBinding): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    binding.guard,
    'assertCurrent',
  );
  if (
    !descriptor ||
    !('value' in descriptor) ||
    descriptor.value !== binding.assertCurrent
  )
    unavailable();
}

/** Bind only a real database guard after trusted Worker validation (the old
 * assistant path also requires checked finalizeRoot). The exact proof object is an in-process rendezvous key;
 * JSON copies, public fields and native RPC outcomes cannot mint this binding. */
export function bindCheckedFinalDeliveryCommitGuard(
  proof: FinalDeliveryProof,
  guard: JobCompletionGuard,
): void {
  const safe = snapshot(proof);
  if (!object(guard)) unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(guard, 'assertCurrent');
  if (
    !descriptor ||
    !('value' in descriptor) ||
    typeof descriptor.value !== 'function'
  )
    unavailable();
  const existing = commitGuards.get(proof);
  if (existing) {
    assertCommit(existing);
    if (
      existing.guard !== guard ||
      fields.some((key) => existing.proof[key] !== safe[key])
    )
      unavailable();
    return;
  }
  commitGuards.set(
    proof,
    Object.freeze({ proof: safe, guard, assertCurrent: descriptor.value }),
  );
}

/** Called only with the proof already checked by the private native/controller
 * boundary. This does not authorize a Job or parse a model/browser receipt. */
export function attachCheckedFinalDelivery(
  target: unknown,
  proof: FinalDeliveryProof,
): void {
  const current = answer(target);
  const safe = snapshot(proof);
  const commit = commitGuards.get(proof);
  if (commit) {
    assertCommit(commit);
    if (fields.some((key) => commit.proof[key] !== safe[key])) unavailable();
  }
  if (digest(current) !== safe.candidateDigest) unavailable();
  const existing = deliveries.get(target as object);
  if (existing) {
    assertAnswer(target, existing);
    if (
      fields.some((key) => existing.proof[key] !== safe[key]) ||
      existing.commit !== commit
    )
      unavailable();
    return;
  }
  deliveries.set(
    target as object,
    Object.freeze({
      answer: current,
      proof: safe,
      ...(commit ? { commit } : {}),
    }),
  );
}

/** Missing metadata stays missing. An attached but changed carrier is an
 * explicit failure; it cannot silently turn into an unchecked/legacy result. */
export function getCheckedFinalDelivery(
  target: unknown,
): FinalDeliveryProof | undefined {
  if (!object(target)) return undefined;
  const entry = deliveries.get(target);
  if (!entry) return undefined;
  assertAnswer(target, entry);
  return entry.proof;
}

/** Explicit copy across a Worker result spread. Both bodies must still be the
 * exact checked string and hash to candidateDigest. Never overwrite a target
 * belonging to another attachment, even if its public answer happens to match. */
export function transferCheckedFinalDelivery(
  source: unknown,
  target: unknown,
): void {
  if (!object(source)) unavailable();
  const entry = deliveries.get(source);
  if (!entry) unavailable();
  assertAnswer(source, entry);
  assertAnswer(target, entry);
  const existing = deliveries.get(target as object);
  if (existing && existing !== entry) unavailable();
  deliveries.set(target as object, entry);
}

/** Use the exact workflowLease object already passed to this handler invocation.
 * Do not read/copy credentials or add a field to that object. */
export function beginCheckedFinalDeliveryExecution(scope: object): void {
  if (!object(scope) || executions.has(scope)) unavailable();
  executions.set(scope, { required: false });
}

/** Irreversible for this invocation. Only the existing trusted assistant
 * controller/route decision may select coverage; browser preferences cannot. */
export function requireCheckedFinalDelivery(scope: object): void {
  if (!object(scope)) unavailable();
  const state = executions.get(scope);
  if (!state || state.output) unavailable();
  state.required = true;
}

/** Transfer the actual handler return spread and bind its object identity to
 * this invocation. Uncovered ordinary handlers do not need a delivery proof. */
export function transferCheckedFinalDeliveryForExecution(
  scope: object,
  source: unknown,
  target: unknown,
): void {
  if (!object(scope)) unavailable();
  const state = executions.get(scope);
  if (!state?.required) {
    if (getCheckedFinalDelivery(source) || getCheckedFinalDelivery(target))
      unavailable();
    return;
  }
  if (!object(source)) unavailable();
  const entry = deliveries.get(source);
  if (!entry?.commit || (state.entry && state.entry !== entry)) unavailable();
  if (state.output && state.output !== target) unavailable();
  transferCheckedFinalDelivery(source, target);
  state.entry = entry;
  state.output = target as object;
}

/** Job-runner reads this before step.completed. Missing metadata in a required
 * invocation is fatal, even if a spread also lost every result-side marker.
 * Root will connect this private union to its final DB commit guard. */
export function readCheckedFinalDeliveryForExecution(
  scope: object,
  result: unknown,
): CheckedFinalDeliveryCoverage {
  if (!object(scope)) unavailable();
  const state = executions.get(scope);
  if (!state) unavailable();
  const proof = getCheckedFinalDelivery(result);
  if (!state.required) {
    if (proof) unavailable();
    return Object.freeze({ coverage: 'uncovered' });
  }
  if (
    !proof ||
    state.output !== result ||
    !object(result) ||
    deliveries.get(result) !== state.entry
  )
    unavailable();
  const commit = deliveries.get(result)!.commit;
  if (!commit) unavailable();
  assertCommit(commit);
  return Object.freeze({
    coverage: 'checked_native_v1',
    proof,
    checkedDelivery: commit.guard,
  });
}
