import type { NativeRootOrigin } from '@allrice/database';
import { lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { DSH_MISSING_FROZEN_GENERATION } from '@allrice/contracts';
import {
  installRetainedDshNativeArtifact,
  nativeArtifactLaunchForPin,
} from './dsh-native-artifact.js';

// Finite historical compatibility policy, independent of later promotion.
const compatibilityGeneration = 'dsh-0.1.5-rc.3-a4c74a9';
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
 * Slot one is the legacy-only default; other slots only serve exact old pins. */
export async function installConfiguredDshNativeRetention() {
  if (installed) fail('ALREADY_CONFIGURED');
  const entries = [];
  for (let slot = 1; slot <= 4; slot++) {
    const prefix = `ALLRICE_DSH_RETAINED_${slot}_`;
    const root = process.env[prefix + 'ROOT']?.trim() ?? '';
    const expectedId = process.env[prefix + 'ARTIFACT_ID']?.trim() ?? '';
    const dataRoot = process.env[prefix + 'STORAGE_ROOT']?.trim() ?? '';
    const tuples = process.env[prefix + 'FROZEN_PROFILES']?.trim() ?? '';
    if (!root && !expectedId && !dataRoot && !tuples) continue;
    if (!root || !expectedId || !dataRoot) fail('CONFIG_PAIR_REQUIRED');
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
    const value = await installRetainedDshNativeArtifact({ root, expectedId });
    if (value.generation !== compatibilityGeneration) fail('GENERATION');
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
      frozenProfiles: profiles,
    });
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

/** The exact independently approved candidate must agree with the immutable
 * business INSERT fact. Neither absence of a pin nor generation alone suffices. */
export function newRootDshNativeLaunch(
  origin: NativeRootOrigin,
  fallback: Launch,
  profileId: Profile,
) {
  const expected = process.env.ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID;
  if (
    !expected ||
    origin.artifactId !== expected ||
    fallback.artifactId !== expected ||
    fallback.generation !== 'dsh-0.2.1-rc.2-687f282' ||
    origin.distributionGeneration !== fallback.generation ||
    origin.profileId !== profileId
  )
    fail('NEW_ROOT_APPROVAL');
  return fallback;
}
