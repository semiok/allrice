import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  correlateP27AssistantDiagnostics,
  retainP27AssistantDiagnostics,
} from './p27-assistant-diagnostics.ts';
import { attachAssistantFailureDiagnostics } from '../../../apps/worker/src/harness/dsh/assistant-diagnostics.ts';

function evidence() {
  const run_id = randomUUID(),
    call_id = randomUUID(),
    native_session_id = randomUUID();
  const snapshotDigest = `sha256:${'a'.repeat(64)}`;
  return {
    snapshotDigest,
    diagnostics: {
      version: 1,
      failures: [
        {
          nativeSessionId: native_session_id,
          callId: call_id,
          phase: 'finish',
          code: 'SERVER',
          stopKind: 'error',
          inputUsageKnown: false,
          outputUsageKnown: false,
          settlementConfirmed: true,
        },
      ],
      truncated: false,
    },
    admissions: [
      {
        call_id,
        run_id,
        native_session_id,
        request_digest: `sha256:${'b'.repeat(64)}`,
        dispatched: true,
        finished: true,
      },
    ],
    receipts: [
      {
        call_id,
        run_id,
        request_digest: `sha256:${'b'.repeat(64)}`,
        snapshot_digest: snapshotDigest,
        usage_complete: false,
        input_usage_known: false,
        output_usage_known: false,
        cache_usage_known: false,
        actual_cost_known: false,
        cost_known: false,
      },
    ],
  };
}
describe('P27 diagnostics correlate with fixture admissions (no provider)', () => {
  it('retains a partial-result sidecar when the later P27 assertion has no native context', () => {
    const input = evidence();
    const result = Object.freeze({
      assistantStatus: 'partial',
      usageComplete: true,
    });
    attachAssistantFailureDiagnostics(result, input.diagnostics);
    const retained = retainP27AssistantDiagnostics(undefined, result);
    const laterAssertion = Error('p27_adapter_assistant_status');
    const afterFailure = retainP27AssistantDiagnostics(
      retained,
      laterAssertion,
    );
    expect(afterFailure).toEqual(input.diagnostics);
    expect(
      correlateP27AssistantDiagnostics({ ...input, diagnostics: afterFailure })
        .status,
    ).toBe('correlated');
    expect(JSON.stringify(result)).not.toContain('SERVER');
  });
  it('keeps native ACK and incomplete ledger receipt as distinct observations', () => {
    const input = evidence();
    const result = correlateP27AssistantDiagnostics(input);
    expect(result).toMatchObject({
      status: 'correlated',
      failures: [
        {
          ...input.diagnostics.failures[0],
          runId: input.admissions[0]!.run_id,
          admissionDispatched: true,
          admissionFinished: true,
          receiptPresent: true,
          receiptUsageComplete: false,
          receiptInputUsageKnown: false,
          receiptOutputUsageKnown: false,
          receiptCostKnown: false,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('cause:');
  });
  it('does not fabricate a receipt when settlement failed', () => {
    const input = evidence();
    input.receipts = [];
    input.diagnostics.failures[0]!.settlementConfirmed = false;
    expect(correlateP27AssistantDiagnostics(input)).toMatchObject({
      status: 'correlated',
      failures: [{ receiptPresent: false, receiptCostKnown: null }],
    });
  });
  it.each([
    'call',
    'session',
    'run',
    'digest',
    'price',
    'duplicate_call',
    'duplicate_receipt',
  ])('rejects mismatched or ambiguous fixture correlation: %s', (kind) => {
    const input = evidence();
    if (kind === 'call') input.diagnostics.failures[0]!.callId = randomUUID();
    if (kind === 'session')
      input.diagnostics.failures[0]!.nativeSessionId = randomUUID();
    if (kind === 'run') input.receipts[0]!.run_id = randomUUID();
    if (kind === 'digest') input.receipts[0]!.request_digest = 'wrong';
    if (kind === 'price') input.receipts[0]!.snapshot_digest = 'wrong';
    if (kind === 'duplicate_call')
      input.admissions.push({ ...input.admissions[0]! });
    if (kind === 'duplicate_receipt')
      input.receipts.push({ ...input.receipts[0]! });
    expect(correlateP27AssistantDiagnostics(input)).toEqual({
      status: 'identity_mismatch',
    });
  });
  it('never saves malformed diagnostics or an unvalidated raw payload', () => {
    const input = evidence();
    expect(
      correlateP27AssistantDiagnostics({
        ...input,
        diagnostics: { ...input.diagnostics, raw: 'synthetic-secret' },
      }),
    ).toEqual({ status: 'unavailable' });
    expect(
      correlateP27AssistantDiagnostics({ ...input, diagnostics: undefined }),
    ).toEqual({ status: 'unavailable' });
  });
});
