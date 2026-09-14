import {
  getAssistantFailureDiagnostics,
  parseAssistantFailureDiagnostics,
  type AssistantFailureDiagnostics,
} from '../../../apps/worker/src/harness/dsh/assistant-diagnostics.ts';

/** A later P27 assertion failure may not be the native execution error. Keep a
 * previously captured result sidecar unless the new error has a validated one. */
export function retainP27AssistantDiagnostics(
  previous: AssistantFailureDiagnostics | undefined,
  resultOrError: unknown,
) {
  return (
    getAssistantFailureDiagnostics(resultOrError) ??
    parseAssistantFailureDiagnostics(previous)
  );
}

/** Only scalar identity/settlement metadata selected from this fixture's root.
 * No prompt, response, receipt usage payload, lease token, or provider message. */
export interface P27DiagnosticAdmission {
  call_id: string;
  run_id: string;
  native_session_id: string;
  request_digest: string | null;
  dispatched: boolean;
  finished: boolean;
}
export interface P27DiagnosticReceipt {
  call_id: string;
  run_id: string;
  request_digest: string;
  snapshot_digest: string;
  usage_complete: boolean;
  input_usage_known: boolean;
  output_usage_known: boolean;
  cache_usage_known: boolean;
  actual_cost_known: boolean;
  cost_known: boolean;
}

/** The host's observation is not PG authority. Only retain diagnostics that
 * match an admitted call/native-session pair belonging to the synthetic root. */
export function correlateP27AssistantDiagnostics(input: {
  diagnostics: unknown;
  admissions: readonly P27DiagnosticAdmission[];
  receipts: readonly P27DiagnosticReceipt[];
  snapshotDigest?: string;
}) {
  const diagnostics = parseAssistantFailureDiagnostics(input.diagnostics);
  if (!diagnostics) return { status: 'unavailable' as const };
  const mismatch = { status: 'identity_mismatch' as const };
  if (
    new Set(input.admissions.map((row) => row.call_id)).size !==
      input.admissions.length ||
    new Set(input.receipts.map((row) => row.call_id)).size !==
      input.receipts.length
  )
    return mismatch;
  const failures = [];
  for (const failure of diagnostics.failures) {
    const call = input.admissions.find((row) => row.call_id === failure.callId);
    if (!call || call.native_session_id !== failure.nativeSessionId)
      return mismatch;
    const receipt = input.receipts.find(
      (row) => row.call_id === failure.callId,
    );
    if (
      receipt &&
      (receipt.run_id !== call.run_id ||
        receipt.request_digest !== call.request_digest ||
        receipt.snapshot_digest !== input.snapshotDigest)
    )
      return mismatch;
    failures.push({
      ...failure,
      runId: call.run_id,
      admissionDispatched: call.dispatched,
      admissionFinished: call.finished,
      receiptPresent: !!receipt,
      // These are independent ledger observations, not inferred from an ACK.
      receiptUsageComplete: receipt?.usage_complete ?? null,
      receiptInputUsageKnown: receipt?.input_usage_known ?? null,
      receiptOutputUsageKnown: receipt?.output_usage_known ?? null,
      receiptCostKnown: receipt?.cost_known ?? null,
    });
  }
  return {
    status: 'correlated' as const,
    version: diagnostics.version,
    failures,
    truncated: diagnostics.truncated,
    scope: 'native_observation_correlated_with_fixture_calls_not_cause_proof',
  };
}
