import { lstat, realpath } from 'node:fs/promises';
import {
  DSH_INSTALLED_DISTRIBUTION,
  NATIVE_JOURNAL_CONTRACT,
} from '@allrice/contracts';
import {
  assertNativeJournalContractCovers,
  inspectNativeContextCompatibility,
  readNativeJournalContractHighWater,
} from '@allrice/database';
import {
  parseNativeScheduleControlReference,
  verifyNativeOnceControlHistory,
} from '../native-schedule-once-loader.js';
import { checkRetiredDshNativeSettings } from './dsh-native-artifact.js';
import { employeePreviewStorageRoot } from './dsh-native-retention.js';
import { configuredDshRuntimeRoot } from './dsh/runtime-pool.js';

/** deploy-dev's pre-stop check of a release candidate, after the caller has
 * installed and launch-checked its primary (MET-221). Contexts bind to the DSH
 * generation and the journal contract, not to an artifact ID: this checks the
 * generation, that the contract reads every journal already written, that every
 * pin is under this deployment's storage roots, and that each control
 * partition's history is readable with the candidate. It writes nothing and
 * reads no close observations: stop_job proves the old Worker exited. Every
 * failure carries the DSH_NATIVE_ prefix deploy-dev reports. */
export async function checkNativeReleaseCandidate(
  primary: { artifactId: string; generation: string },
  options: {
    sql?: Parameters<typeof inspectNativeContextCompatibility>[1];
    verifyControlHistory?: typeof verifyNativeOnceControlHistory;
  } = {},
) {
  const ignoredSettings = checkRetiredDshNativeSettings();
  if (primary.generation !== DSH_INSTALLED_DISTRIBUTION.generation)
    throw Error('DSH_NATIVE_ARTIFACT_GENERATION');
  const journal = await readNativeJournalContractHighWater(options.sql);
  assertNativeJournalContractCovers(NATIVE_JOURNAL_CONTRACT, journal.highWater);
  const storageRoots = [
    configuredDshRuntimeRoot(),
    employeePreviewStorageRoot(),
  ];
  const contexts = await inspectNativeContextCompatibility(
    { generation: primary.generation, storageRoots },
    options.sql,
  );
  if (contexts.pinsOutsideStorageRoots)
    throw Error(
      `DSH_NATIVE_CONTEXT_STORAGE_MOVED ${contexts.pinsOutsideStorageRoots} pins outside ${storageRoots.join(', ')}`,
    );
  const verify = options.verifyControlHistory ?? verifyNativeOnceControlHistory;
  let controlSessionsVerified = 0;
  for (const partition of contexts.controlPartitions) {
    try {
      const reference = parseNativeScheduleControlReference(
        partition.reference,
      );
      const stat = await lstat(reference.stateRoot);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await realpath(reference.stateRoot)) !== reference.stateRoot
      )
        throw Error('state root is not a real directory');
      controlSessionsVerified += await verify(reference, partition.controls);
    } catch (error) {
      const detail =
        error instanceof Error
          ? ((error as { code?: string }).code ?? error.message)
          : String(error);
      throw Error(
        `DSH_NATIVE_CONTROL_HISTORY_UNREADABLE ${partition.partitionId}: ${detail}`,
      );
    }
  }
  return {
    journalContract: { ...NATIVE_JOURNAL_CONTRACT, ...journal },
    contexts: {
      incompatibleChats: contexts.incompatibleChats,
      incompatiblePins: contexts.incompatiblePins,
      controlPartitions: contexts.controlPartitions.length,
      controlSessionsVerified,
    },
    ignoredSettings,
  };
}
