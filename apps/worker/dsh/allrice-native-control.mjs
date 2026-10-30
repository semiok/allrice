/* global AbortController, AbortSignal */
import { NativeSubagentControlRequestSchema } from '@allrice/contracts/native-runtime';
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import { clearTimeout, setTimeout } from 'node:timers';
import { readNativeSubagentSummary } from './allrice-native-query.mjs';

/** SaaS ingress over the public human controls. DSH owns acceptance, queueing,
 * cancellation and cold-child continuation; this port never acquires a Host. */
export async function controlNativeSubagent(host, params) {
  const { scope, input } = NativeSubagentControlRequestSchema.parse(params);
  const root = host.requireRoot(scope.nativeRootId);
  if (!host.runAdmission) throw Error('RUN_NOT_ACTIVE');
  const window = host.runAdmission.inputWindow(scope.rootRunId);
  const check = () => {
    window.check();
    host.assertRoot(root, scope.nativeRootId);
    host.runFinalDelivery?.assertAccepting(scope.nativeRootId);
  };
  check();
  const tree = await readNativeSubagentSummary(
    host.ctx,
    scope.nativeRootId,
    window.signal,
  );
  check();
  if (
    !tree.descendants.some(
      (row) =>
        row.kind === 'child' &&
        row.id === input.childSessionId &&
        row.parentId === input.parentSessionId &&
        row.mode === 'continuable',
    )
  )
    throw Error('NATIVE_CONTROL_CHILD_UNVERIFIED');
  // Address failures stay command-local. Only the bound Worker can grant its
  // current Run authority; no lease token or caller-selected expiry enters here.
  const grant = await host.transport.request(
    'allrice/subagent-authorize',
    {
      ...host.runAdmission.attribute({ nativeSessionId: scope.nativeRootId }),
      scope,
    },
    window.signal,
  );
  check();
  if (
    !Number.isSafeInteger(grant?.validUntil) ||
    grant.validUntil <= Date.now()
  )
    throw Error('NATIVE_CONTROL_GRANT_EXPIRED');
  const expiry = new AbortController();
  const timer = setTimeout(
    () => expiry.abort(Error('NATIVE_CONTROL_GRANT_EXPIRED')),
    grant.validUntil - Date.now(),
  );
  timer.unref();
  try {
    const signal = AbortSignal.any([window.signal, expiry.signal]);
    signal.throwIfAborted();
    if (input.kind === 'interrupt') {
      return {
        kind: 'interrupt',
        ...host.ctx.subagents.interruptByParent(
          input.childSessionId,
          input.parentSessionId,
          input.mode,
        ),
      };
    }
    const { kind, ...prompt } = input;
    // Do not check cancellation after acceptance or turn a lost ACK into retry.
    return { kind, ...(await host.ctx.subagents.prompt(prompt, signal)) };
  } catch (error) {
    // SDK error frames discard native codes. Preserve only public, definite
    // admission refusals as a result; cancellation/internal remain unknown.
    const refusal = remoteErrorOf(error);
    if (
      refusal &&
      [
        'gateway/bad-request',
        'subagent/attachment-invalid',
        'subagent/invalid-time-zone',
        'subagent/parent-unavailable',
        'subagent/not-resumable',
        'subagent/unauthorized',
        'subagent/delivery-unavailable',
      ].includes(refusal.code)
    )
      return { status: 'rejected', code: refusal.code };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
