import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  assertNativeRootOrigin,
  nativeRootDigest,
  newCurrentInternalNativeRootOrigin,
  NativeRootOriginV1Schema,
} from './native-root-origin.ts';

const current = 'sha256:' + 'a'.repeat(64);
const other = 'sha256:' + 'b'.repeat(64);
const kinds = ['platform_technical', 'experience_consolidation'] as const;
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (key.startsWith('ALLRICE_DSH_ORIGIN_READER_'))
      vi.stubEnv(key, undefined);
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', undefined);
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', undefined);
});
afterEach(() => vi.unstubAllEnvs());

// MET-221: a new birth records this release's primary as provenance. The
// retired new-root ID and origin-reader settings are neither read nor needed.
it.each(kinds)(
  'requires the release primary for new %s work, not the retired new-root ID',
  (kind) => {
    expect(() =>
      newCurrentInternalNativeRootOrigin(kind, randomUUID(), { v: 1 }),
    ).toThrow();
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', current);
    expect(() =>
      newCurrentInternalNativeRootOrigin(kind, randomUUID(), { v: 1 }),
    ).toThrow();
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', undefined);
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', current);
    expect(
      newCurrentInternalNativeRootOrigin(kind, randomUUID(), { v: 1 })
        .artifactId,
    ).toBe(current);
  },
);

it.each(kinds)(
  'records only the release primary for new %s work regardless of retired settings',
  (kind) => {
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', current);
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', other);
    for (const reader of [undefined, '', '/synthetic/reader.json']) {
      vi.stubEnv('ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH', reader);
      expect(
        newCurrentInternalNativeRootOrigin(kind, randomUUID(), { v: 1 })
          .artifactId,
      ).toBe(other);
    }
  },
);

it.each(kinds)('freezes the exact recipe and original %s profile', (kind) => {
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', current);
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', current);
  const id = randomUUID();
  const recipe = { z: [{ step: 'read-only', budget: 1 }], a: 'original' };
  const origin = newCurrentInternalNativeRootOrigin(kind, id, recipe);
  expect(origin).toEqual({
    schemaVersion: 1,
    contextKind: kind,
    contextId: id,
    rootSeed: kind === 'experience_consolidation' ? `experience-${id}` : id,
    distributionGeneration: 'dsh-0.2.1-rc.2-687f282',
    profileId: kind === 'platform_technical' ? 'technical' : 'restricted',
    artifactId: current,
    frozenIdentity: {
      kind: 'internal_recipe',
      checksum: nativeRootDigest(recipe),
    },
  });
  // A deployed approval change affects the next birth, not stored history.
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', other);
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', other);
  expect(
    assertNativeRootOrigin(origin, kind, id, origin.frozenIdentity),
  ).toEqual(origin);
  expect(
    newCurrentInternalNativeRootOrigin(kind, randomUUID(), recipe).artifactId,
  ).toBe(other);
  expect(() =>
    assertNativeRootOrigin(origin, kind, id, {
      kind: 'internal_recipe',
      checksum: nativeRootDigest({ ...recipe, a: 'changed' }),
    }),
  ).toThrow('NATIVE_ROOT_ORIGIN_INVALID');
});

it.each(kinds)(
  'reads historical %s NULL/v1 without current approval',
  (kind) => {
    const id = randomUUID(),
      identity = {
        kind: 'internal_recipe' as const,
        checksum: nativeRootDigest({ v: 1 }),
      };
    expect(assertNativeRootOrigin(null, kind, id, identity)).toBeNull();
    const historical = NativeRootOriginV1Schema.parse({
      schemaVersion: 1,
      contextKind: kind,
      contextId: id,
      rootSeed: kind === 'experience_consolidation' ? `experience-${id}` : id,
      distributionGeneration: 'dsh-0.2.1-rc.2-687f282',
      profileId: kind === 'platform_technical' ? 'technical' : 'restricted',
      artifactId: other,
      frozenIdentity: identity,
    });
    expect(assertNativeRootOrigin(historical, kind, id, identity)).toEqual(
      historical,
    );
  },
);

it.each(kinds)(
  'does not accept malformed or padded %s approval IDs',
  (kind) => {
    for (const bad of [
      ' ',
      'not-a-digest',
      current + ' ',
      'SHA256:' + 'a'.repeat(64),
    ]) {
      vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', bad);
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', bad);
      expect(() =>
        newCurrentInternalNativeRootOrigin(kind, randomUUID(), { v: 1 }),
      ).toThrow();
    }
  },
);
