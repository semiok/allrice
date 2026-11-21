import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import * as React from 'react';
import * as Jsx from 'react/jsx-runtime';
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives';
import * as Zod from 'zod';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it, vi } from 'vitest';
import { bindEmployeePanels } from '../src/employee-panels';
import { writeEmployeePanelsFixture } from './employee-panels-fixture';
import { createFixture } from './fixtures/employee-panels/client';
import { nativeClientModule } from './native-client-module.mjs';
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
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.unstubAllGlobals();
  for (const path of roots.splice(0))
    await rm(path, { recursive: true, force: true });
});

it('observes its provided panels owner through real Cordis injection across unload and rebind', async () => {
  const ctx = new Context();
  contexts.push(ctx);
  const { SlotRegistry } = nativeClientModule(
    '@deepseek-ai/dsh-client-ui-renderer',
  );
  new SlotRegistry(ctx);
  // Only the other native UI faces are synthetic. Cordis service access and
  // the actual product binder/lifetime remain real; no Host/browser is used.
  const release = vi.fn();
  let mounted: string | undefined;
  const list = {
    getSnapshot: () => ({ phase: 'ready' }),
    subscribe: () => () => {},
  };
  ctx.provide('sessions', {
    list,
    retain: () => ({ ready: Promise.resolve({ ctx }), release }),
  });
  ctx.provide('workspaces', { list });
  ctx.provide('uiWorkspace', {
    openSession: (id: string) => {
      mounted = id;
    },
  });
  ctx.provide('sidebarRight', {
    mounted: { getSnapshot: () => mounted },
    isExpanded: () => false,
    active: () => undefined,
  });
  ctx.provide('layout', {});
  ctx.provide('theme', {});
  ctx.provide('conversation', {});
  vi.stubGlobal('window', {});
  const fixture = createFixture(() => ({ bindEmployeePanels }));
  // This provider must be able to start before its own service exists.
  expect(fixture.inject).not.toContain('allriceEmployeePanels');
  const fork = ctx.plugin(fixture);
  await fork;
  await vi.waitFor(() =>
    expect(window.__allricePanelsIntegration?.evidence().ownerBound).toBe(true),
  );
  const integration = window.__allricePanelsIntegration!;
  expect(integration.evidence().nativeInputReady).toBe(true);
  await integration.unload();
  expect(integration.evidence()).toMatchObject({
    ownerBound: false,
    oldOwnerAborted: true,
  });
  await integration.rebind();
  await vi.waitFor(() => expect(integration.evidence().ownerBound).toBe(true));
  await fork.dispose();
  expect(window.__allricePanelsIntegration).toBeUndefined();
  expect(release).toHaveBeenCalledTimes(2);
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
  const stylesheet = (artifact: string) => {
    const literal = artifact.match(
      /style\.textContent\s*=\s*("(?:\\.|[^"\\])*");/,
    );
    expect(literal).not.toBeNull();
    return JSON.parse(literal![1]!) as string;
  };
  const classes = (css: string) =>
    new Set(
      [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((rule) =>
        [...rule[1]!.matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g)].map(
          (match) => match[1]!,
        ),
      ),
    );
  const productClasses = classes(
    stylesheet(
      await readFile(new URL('../dist/client.js', import.meta.url), 'utf8'),
    ),
  );
  const fixtureClasses = classes(stylesheet(await readFile(file, 'utf8')));
  expect(fixtureClasses.size).toBeGreaterThan(0);
  expect(
    [...fixtureClasses].filter((name) => productClasses.has(name)),
  ).toEqual([]);
});

it('validates prepared rev2 identities and rejects modified bytes before browser startup without requiring git history', async () => {
  const prepared = await directory(),
    output = await directory();
  const hash = (bytes: string | Buffer) =>
    createHash('sha256').update(bytes).digest('hex');
  // Artifact-codec fixture only, never a visual baseline or passed to a
  // browser. Real pinned-source generation is a separate preparation step;
  // shallow CI/source archives can validate its supplied artifact identities.
  const html = '<!doctype html><p>synthetic artifact codec test only</p>';
  const file = join(prepared, 'panels-rev2.html');
  const metadata = {
    head: panelsRev2Head,
    htmlSha256: hash(html),
    replaySources: await Promise.all(
      ['baseline.tsx', 'data.ts', 'presentation.tsx', 'presentation.css'].map(
        async (name) => ({
          name,
          sha256: hash(
            await readFile(
              new URL('./fixtures/employee-panels/' + name, import.meta.url),
            ),
          ),
        }),
      ),
    ),
    sources: Object.entries(panelsRev2Sources).map(([name, sha256]) => ({
      path: 'apps/web/app/chatflow/' + name,
      sha256,
    })),
    sourcePolicy:
      'synthetic artifact codec test; never used as browser baseline',
  };
  await writeFile(file, html);
  await writeFile(
    join(prepared, 'panels-rev2-sources.json'),
    JSON.stringify(metadata),
  );
  await writeEmployeePanelsBaseline(output, prepared);
  expect(await readFile(join(output, 'panels-rev2.html'), 'utf8')).toBe(html);
  await writeFile(file, html + 'tampered');
  await expect(writeEmployeePanelsBaseline(output, prepared)).rejects.toThrow(
    'identity/hash mismatch',
  );
  await writeFile(file, html);
  metadata.sources[0]!.sha256 = '0'.repeat(64);
  await writeFile(
    join(prepared, 'panels-rev2-sources.json'),
    JSON.stringify(metadata),
  );
  await expect(writeEmployeePanelsBaseline(output, prepared)).rejects.toThrow(
    'identity/hash mismatch',
  );
}, 30_000);
