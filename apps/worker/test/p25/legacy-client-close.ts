import {
  DshRuntimeCloseError,
  type DshProtocolClient,
  type DshRuntimeCloseEvidence,
  type DshRuntimeProcessState,
} from '../../src/harness/dsh-protocol-client.js';

type FixtureClient = Pick<
  DshProtocolClient,
  'close' | 'processState' | 'closureEvidence'
>;

function normalExit(process: DshRuntimeProcessState) {
  return (
    process.state === 'exited' &&
    process.stdioClosed &&
    process.exitCode === 0 &&
    process.signal === null
  );
}

function retainedPhysicalClose(
  evidence: DshRuntimeCloseEvidence | null,
): evidence is DshRuntimeCloseEvidence {
  return (
    !!evidence &&
    normalExit(evidence.process) &&
    evidence.shutdownAcknowledged &&
    !evidence.wrapperCleanupConfirmed &&
    evidence.terminationAttempted === null
  );
}

/** Test-only handling for the immutable 0.1.5 reader. A normal exit releases
 * its writer but does not manufacture the current wrapper's semantic proof.
 * Every other close failure is still fatal, including observation failures.
 */
export async function closeLegacyFixtureClient(
  client: FixtureClient,
  reader: 'retained' | 'candidate',
) {
  if (reader === 'candidate') {
    await client.close();
    return client.closureEvidence();
  }
  try {
    await client.close();
  } catch (error) {
    if (!(error instanceof DshRuntimeCloseError)) throw error;
    const evidence = client.closureEvidence();
    if (
      !normalExit(client.processState()) ||
      !retainedPhysicalClose(error.evidence) ||
      !retainedPhysicalClose(evidence)
    )
      throw error;
    return evidence;
  }
  throw new Error(
    'Immutable retained fixture unexpectedly supplied a semantic close proof',
  );
}
