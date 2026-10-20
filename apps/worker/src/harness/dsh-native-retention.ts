import {
  verifyNativeArtifactReferenceCoverage,
  configuredNativeOriginReaders,
  nativeOriginReaderForBinding,
  nativeOriginReaderForOrigin,
  inspectNativeOriginReaderStates,
  type NativeRootOrigin,
  type NativeSessionPin,
  type NativeOriginReaderScope,
} from '@allrice/database';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { DSH_MISSING_FROZEN_GENERATION } from '@allrice/contracts';
import {
  installRetainedDshNativeArtifact,
  nativeArtifactLaunchForPin,
  type DshNativeVerificationObserver,
} from './dsh-native-artifact.js';
import { assertVirginNativeNamespace } from './native-origin-storage.js';
import { assertStoredNativeSession } from './dsh-native-storage.js';
import {
  parseNativeOnceControlReference,
  verifyNativeOnceControlHistory,
} from '../native-schedule-once-loader.js';

// Finite historical compatibility policy, independent of later promotion.
const compatibilityGeneration = 'dsh-0.1.5-rc.3-a4c74a9';
const currentGeneration = 'dsh-0.2.1-rc.2-687f282';
const historicalFrozenGeneration = 'dsh-0.1.1-rc.2-b150a55';
type Profile = 'restricted' | 'technical';
type Launch = ReturnType<typeof nativeArtifactLaunchForPin>;
const retained = new Map<
  string,
  {
    launch: Awaited<ReturnType<typeof installRetainedDshNativeArtifact>>;
    storageRoot: string;
    frozenProfiles: { generation: string; profileId: Profile }[];
  }
>();
let defaultLegacyId: string | undefined;
let installed = false;
const fail = (reason: string): never => {
  throw Error('DSH_NATIVE_ARTIFACT_RETAINED_' + reason);
};

/** Each absolute root is also an explicit launchd/env reference understood by
 * the existing cleanup tool. Never rely on an ID or an opaque JSON path alone.
 * Slot one is the legacy-only default; other slots serve exact pins/origins.
 * A new primary never implicitly replaces an independently approved artifact. */
export type RetainedVerificationObservation =
  | { slot: number; kind: 'started' | 'completed' }
  | { slot: number; kind: 'failed'; error: unknown }
  | {
      slot: number;
      kind: 'metric';
      metric: Parameters<DshNativeVerificationObserver>[0];
    };
export async function installConfiguredDshNativeRetention(
  options: {
    observe?: (event: RetainedVerificationObservation) => void;
  } = {},
) {
  const observe = (event: RetainedVerificationObservation) => {
    try {
      options.observe?.(event);
    } catch {
      /* a diagnostic cannot bypass policy */
    }
  };
  if (installed) fail('ALREADY_CONFIGURED');
  if (
    Object.keys(process.env).some((key) => {
      const match = /^ALLRICE_DSH_RETAINED_(\d+)_/.exec(key);
      return match && (Number(match[1]) < 1 || Number(match[1]) > 7);
    })
  )
    fail('SLOT_LIMIT');
  const entries = [];
  for (let slot = 1; slot <= 7; slot++) {
    const prefix = `ALLRICE_DSH_RETAINED_${slot}_`;
    const root = process.env[prefix + 'ROOT']?.trim() ?? '';
    const expectedId = process.env[prefix + 'ARTIFACT_ID']?.trim() ?? '';
    const dataRoot = process.env[prefix + 'STORAGE_ROOT']?.trim() ?? '';
    const tuples = process.env[prefix + 'FROZEN_PROFILES']?.trim() ?? '';
    const sourceSha = process.env[prefix + 'SOURCE_SHA']?.trim() ?? '';
    const sourceTree = process.env[prefix + 'SOURCE_TREE']?.trim() ?? '';
    if (
      !root &&
      !expectedId &&
      !dataRoot &&
      !tuples &&
      !sourceSha &&
      !sourceTree
    )
      continue;
    observe({ slot, kind: 'started' });
    try {
      if (!root || !expectedId || !dataRoot) fail('CONFIG_PAIR_REQUIRED');
      // Existing slot one predates provenance configuration; preserve its exact
      // approved tuple. Additional historical artifacts must also pin provenance.
      if (
        (slot > 1 || sourceSha || sourceTree) &&
        (!/^[a-f0-9]{40}$/.test(sourceSha) ||
          !/^[a-f0-9]{40}$/.test(sourceTree))
      )
        fail('SOURCE_PAIR_REQUIRED');
      if (slot !== 1 && !defaultLegacyId) fail('FIRST_SLOT_REQUIRED');
      if (!isAbsolute(dataRoot) || resolve(dataRoot) !== dataRoot)
        fail('STORAGE_ROOT');
      const stat = await lstat(dataRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('STORAGE_ROOT');
      const profiles: { generation: string; profileId: Profile }[] = tuples
        ? JSON.parse(tuples)
        : [];
      if (
        !Array.isArray(profiles) ||
        profiles.length > 2 ||
        profiles.some(
          (item) =>
            !item ||
            Object.keys(item).sort().join(',') !== 'generation,profileId' ||
            item.generation !== historicalFrozenGeneration ||
            !['restricted', 'technical'].includes(item.profileId),
        )
      )
        fail('FROZEN_TUPLE');
      const value = await installRetainedDshNativeArtifact({
        root,
        expectedId,
        ...(sourceSha ? { sourceSha, sourceTree } : {}),
        ...(options.observe
          ? {
              observe: (metric: Parameters<DshNativeVerificationObserver>[0]) =>
                observe({ slot, kind: 'metric', metric }),
            }
          : {}),
      });
      if (
        (slot === 1 && value.generation !== compatibilityGeneration) ||
        ![compatibilityGeneration, currentGeneration].includes(value.generation)
      )
        fail('GENERATION');
      if (profiles.length && value.generation !== compatibilityGeneration)
        fail('FROZEN_TUPLE');
      retained.set(value.artifactId, {
        launch: value,
        storageRoot: dataRoot,
        frozenProfiles: profiles,
      });
      if (slot === 1) defaultLegacyId = value.artifactId;
      entries.push({
        slot,
        artifactId: value.artifactId,
        generation: value.generation,
        root: value.root,
        storageRoot: dataRoot,
        ...(sourceSha ? { sourceSha, sourceTree } : {}),
        frozenProfiles: profiles,
      });
      observe({ slot, kind: 'completed' });
    } catch (error) {
      observe({ slot, kind: 'failed', error });
      throw error;
    }
  }
  installed = true;
  return entries;
}

/** Absence of a pin is never evidence of a new candidate root. Contexts without
 * an immutable business origin stay on the approved compatibility reader;
 * their ordinary bind still precedes acquisition. */
export function legacyDshNativeLaunch(fallback: Launch, profileId: Profile) {
  const launch = defaultLegacyId
    ? nativeArtifactLaunchForPin({ artifactId: defaultLegacyId, profileId })
    : fallback;
  if (launch.generation !== compatibilityGeneration) fail('LEGACY_UNAVAILABLE');
  return launch;
}

export function retainedDshStorageRoot(artifactId: string) {
  return retained.get(artifactId)?.storageRoot;
}

/** Same effective execution root as the Worker and its preview executor. */
export function employeePreviewStorageRoot() {
  return resolve(
    process.env.ALLRICE_EXECUTION_ROOT ?? '.local/executions',
    'platform-employee-tests',
  );
}

/** Reused by the pre-stop release check and before Worker producers start.
 * A free slot is not evidence that an unbound origin no longer needs its code. */
export async function verifyConfiguredDshNativeReferences(
  primary: {
    artifactId: string;
    generation: string;
  },
  options: { requireReaderIdle?: boolean } = {},
) {
  const previewStorage = { previewStorageRoot: employeePreviewStorageRoot() };
  const coverage = await verifyNativeArtifactReferenceCoverage([
    {
      artifactId: primary.artifactId,
      generation: primary.generation,
      storageRoot: resolve(
        process.env.ALLRICE_DSH_RUNTIME_ROOT ?? '.local/dsh-runtime',
      ),
      ...previewStorage,
    },
    ...[...retained.values()].map((value) => ({
      artifactId: value.launch.artifactId,
      generation: value.launch.generation,
      storageRoot: value.storageRoot,
      ...previewStorage,
    })),
  ] as Parameters<typeof verifyNativeArtifactReferenceCoverage>[0]);
  const states = await inspectNativeOriginReaderStates({
    requireIdle: options.requireReaderIdle,
  });
  let nativeOnceControlHistoryVerified = 0;
  // DB returns this independent control class for every persistent partition,
  // including closed/expired writers. No business pin/profile is manufactured.
  for (const control of coverage.nativeOnceControlReferences) {
    const reference = parseNativeOnceControlReference(control.reference);
    const stat = await lstat(reference.stateRoot);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(reference.stateRoot)) !== reference.stateRoot
    )
      fail('CONTROL_STORAGE_ROOT');
    if (options.requireReaderIdle)
      nativeOnceControlHistoryVerified += await verifyNativeOnceControlHistory(
        reference,
        control.controls,
      );
  }
  for (const { approval, adopted, nativeSessionIds } of states) {
    const signal = AbortSignal.timeout(30_000);
    if (!adopted)
      await assertVirginNativeNamespace(approval.storageNamespace, signal);
    // A crash restart must let the normal per-Job recovery path diagnose a
    // missing journal; it must not block all producers on one adopted context.
    else if (options.requireReaderIdle) {
      const launch = nativeArtifactLaunchForPin({
        artifactId: approval.targetArtifactId,
        profileId: approval.profileId,
      });
      for (const nativeSessionId of nativeSessionIds)
        await assertStoredNativeSession(
          launch.args[0]!,
          {
            nativeSessionId,
            artifactId: approval.targetArtifactId,
            artifactManifestDigest: approval.targetArtifactId,
            distributionGeneration: approval.generation,
            profileId: approval.profileId,
            storageContextKey: approval.contextId,
            storageNamespace: approval.storageNamespace,
            originReaderApprovalDigest: approval.approvalDigest,
          },
          signal,
        );
    }
  }
  return {
    ...coverage,
    ...(states.length ? { readerStorageVerified: states.length } : {}),
    ...(coverage.nativeOnceControlReferences.length
      ? { nativeOnceControlHistoryVerified }
      : {}),
  };
}

export function assertDshFrozenCompatibility(
  generation: string | undefined,
  launch: Launch,
  profileId: Profile,
) {
  const frozen = generation ?? DSH_MISSING_FROZEN_GENERATION;
  if (frozen === launch.generation) return;
  const value = retained.get(launch.artifactId);
  if (
    value?.frozenProfiles.some(
      (p) => p.generation === frozen && p.profileId === profileId,
    )
  )
    return;
  fail('FROZEN_GENERATION_MISMATCH');
}

/** Fulfil the immutable business INSERT fact using its independently approved
 * artifact. The current new-birth switch is not revocation of existing origins. */
export function originDshNativeLaunch(
  origin: NativeRootOrigin,
  profileId: Profile,
  scope?: NativeOriginReaderScope,
) {
  if (!scope && process.env.ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH)
    fail('ORIGIN_SCOPE_REQUIRED');
  const reader = scope ? nativeOriginReaderForOrigin(origin, scope) : undefined;
  const selected = nativeArtifactLaunchForPin({
    artifactId: reader?.targetArtifactId ?? origin.artifactId,
    profileId,
  });
  if (
    selected.generation !== currentGeneration ||
    origin.distributionGeneration !== selected.generation ||
    origin.profileId !== profileId
  )
    fail('ORIGIN_APPROVAL');
  return {
    ...selected,
    ...(reader
      ? {
          originReaderApprovalDigest: reader.approvalDigest,
          originStorageNamespace: reader.storageNamespace,
        }
      : {}),
  };
}

/** artifactId remains the actual first writer. This narrow approval never
 * reinterprets an existing old writer as a newly approved current writer. */
export function pinnedDshNativeLaunch(pin: NativeSessionPin) {
  const reader = pin.originReaderApprovalDigest
    ? nativeOriginReaderForBinding({
        ...pin,
        originReaderApprovalDigest: pin.originReaderApprovalDigest,
      })
    : undefined;
  if (
    reader &&
    (pin.rootOriginDigest !== reader.originDigest ||
      pin.artifactManifestDigest !== reader.targetArtifactId ||
      pin.distributionGeneration !== reader.generation ||
      pin.bindingBasis !== 'business_root_origin')
  )
    fail('ORIGIN_APPROVAL');
  if (
    !reader &&
    configuredNativeOriginReaders().some(
      (entry) => entry.sourceArtifactId === pin.artifactId,
    )
  )
    fail('EXISTING_WRITER_NOT_MIGRATED');
  return {
    ...nativeArtifactLaunchForPin(pin),
    ...(reader
      ? {
          originReaderApprovalDigest: reader.approvalDigest,
          originStorageNamespace: reader.storageNamespace,
        }
      : {}),
  };
}
