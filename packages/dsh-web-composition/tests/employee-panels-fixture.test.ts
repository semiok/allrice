import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as Jsx from 'react/jsx-runtime';
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives';
import * as Zod from 'zod';
import { afterEach, expect, it } from 'vitest';
import { writeEmployeePanelsFixture } from './employee-panels-fixture';
import {
  panelsRev2Head,
  panelsRev2Sources,
  writeEmployeePanelsBaseline,
} from './employee-panels-baseline';
import {
  createSyntheticPanelsData,
  panelStates,
} from './fixtures/employee-panels/data';

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'allrice-panels-static-'));
  roots.push(path);
  return path;
}

it('validates every synthetic state with original schemas and immutable revision selection', () => {
  for (const state of panelStates) {
    const data = createSyntheticPanelsData(state);
    expect(data.catalog.references.length).toBe(
      state === 'empty' ? 0 : state === 'longname' ? 4 : 5,
    );
    expect(data.files.files.map((file) => file.fileName)).toEqual(
      data.catalog.references.map((reference) => reference.fileName),
    );
    expect(
      data.files.files.every(
        (file) =>
          file.origin === 'business-deliverable' ||
          file.origin === 'user-upload',
      ),
    ).toBe(true);
    for (const reference of data.catalog.references)
      expect(data.selection(reference.revisionId).selection).toMatchObject({
        sourceId: reference.sourceId,
        revisionId: reference.revisionId,
        revision: reference.revision,
        checksum: reference.checksum,
        digest: reference.checksum,
      });
    expect(() => data.selection('unknown')).toThrow(
      'Unknown synthetic revision',
    );
  }
});

it('builds a separate synthetic owner that requests the installed public binder without copying product/ChatflowClient', async () => {
  const path = await directory();
  const file = await writeEmployeePanelsFixture(path);
  let installed: { inject: string[]; apply: unknown } | undefined;
  const requested: string[] = [];
  const baseline = {
    react: React,
    'react/jsx-runtime': Jsx,
    '@deepseek-ai/dsh-client-ui-primitives': Primitives,
    zod: Zod,
    '@allrice/dsh-web-composition': { bindEmployeePanels: () => {} },
  };
  runInNewContext(await readFile(file, 'utf8'), {
    window: {
      __ModuleLoader__: {
        load(module: {
          factory: (require: (name: string) => unknown) => typeof installed;
        }) {
          installed = module.factory((name) => {
            requested.push(name);
            if (!(name in baseline))
              throw Error('Unpublished fixture external: ' + name);
            return baseline[name as keyof typeof baseline];
          });
        },
      },
    },
  });
  expect(typeof installed?.apply).toBe('function');
  expect(installed?.inject).toEqual(
    expect.arrayContaining([
      'sidebarRight',
      'conversation',
      'slots',
      'uiWorkspace',
    ]),
  );
  expect(requested).toContain('@allrice/dsh-web-composition');
  const metadata = JSON.parse(
    await readFile(join(path, 'panels-fixture-build.json'), 'utf8'),
  );
  expect(
    metadata.inputs.some((input: string) =>
      /src\/employee-panels\.tsx$|chatflow-client\.tsx$/.test(input),
    ),
  ).toBe(false);
});

it('pins the complete original rev2 source graph and rejects modified prepared bytes/identities before browser startup', async () => {
  const prepared = await directory(),
    output = await directory();
  const file = await writeEmployeePanelsBaseline(prepared, undefined);
  const html = await readFile(file, 'utf8');
  const metadata = JSON.parse(
    await readFile(join(prepared, 'panels-rev2-sources.json'), 'utf8'),
  );
  expect(metadata.head).toBe(panelsRev2Head);
  for (const [name, sha256] of Object.entries(panelsRev2Sources))
    expect(metadata.sources).toContainEqual({
      path: 'apps/web/app/chatflow/' + name,
      sha256,
    });
  expect(
    metadata.sources.some(
      (source: { path: string }) => source.path === 'apps/web/app/layout.tsx',
    ),
  ).toBe(true);
  expect(html).toContain('data-panels-rev2-replay');
  await writeEmployeePanelsBaseline(output, prepared);
  expect(await readFile(join(output, 'panels-rev2.html'), 'utf8')).toBe(html);
  await writeFile(file, html + 'tampered');
  await expect(writeEmployeePanelsBaseline(output, prepared)).rejects.toThrow(
    'identity/hash mismatch',
  );
  await writeFile(file, html);
  metadata.sources[0].sha256 = '0'.repeat(64);
  await writeFile(
    join(prepared, 'panels-rev2-sources.json'),
    JSON.stringify(metadata),
  );
  await expect(writeEmployeePanelsBaseline(output, prepared)).rejects.toThrow(
    'identity/hash mismatch',
  );
}, 30_000);
