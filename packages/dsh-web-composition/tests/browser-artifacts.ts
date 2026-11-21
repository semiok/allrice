import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The default evidence parent is independent of disposable credential roots. */
export async function createBrowserArtifacts(
  configuredParent = process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR,
) {
  const parent = resolve(
    configuredParent ?? join(tmpdir(), 'allrice-composition-evidence'),
  );
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, 'employee-sidebar-'));
}
