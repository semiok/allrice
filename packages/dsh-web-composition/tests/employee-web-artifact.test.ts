import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildEmployeeWebArtifact } from '../build-web-entry.mjs';

it('refuses to overwrite a previous release before launching a build or replacing bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'employee-web-immutable-'));
  try {
    // Codec fixture for immutable publication, never a runtime owner/graph.
    await writeFile(join(directory, 'artifact.json'), '{"original":true}');
    await writeFile(join(directory, 'client.js'), 'original release bytes');
    await expect(buildEmployeeWebArtifact(directory)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(join(directory, 'artifact.json'), 'utf8')).toBe(
      '{"original":true}',
    );
    expect(await readFile(join(directory, 'client.js'), 'utf8')).toBe(
      'original release bytes',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
