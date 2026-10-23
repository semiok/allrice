import { vi } from 'vitest';

/** Synthetic SQL fixtures only. This does not register or measure a native
 * artifact and must never be used by a live Worker/model acceptance driver. */
export function approveSyntheticCurrentEmployeeExecution() {
  if (!process.env.ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID)
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', 'sha256:' + 'a'.repeat(64));
  if (!process.env.ALLRICE_DSH_NATIVE_ARTIFACT_ID)
    vi.stubEnv(
      'ALLRICE_DSH_NATIVE_ARTIFACT_ID',
      process.env.ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID!,
    );
}
