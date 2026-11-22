import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import * as React from 'react';
import * as Jsx from 'react/jsx-runtime';
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives';
import * as Zod from 'zod';
import { Context } from '@deepseek-ai/cordis';
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots';
import { afterEach, expect, it, vi } from 'vitest';
import { EnterpriseMaterialsPanel } from '../../../apps/web/app/chatflow/enterprise-materials-panel';
import { WorkbenchFilesPanel } from '../../../apps/web/app/chatflow/workbench-files-panel';
import { EmployeeMemorySidebar } from '../../../apps/web/app/chatflow/employee-memory-sidebar';
import { EmployeeCapabilitiesPanel } from '../../../apps/web/app/chatflow/employee-capabilities-panel';
import { panelsRev2Head, panelsRev2Sources } from './employee-panels-baseline';
import {
  compareNativePanelsHostBudget,
  panelsReferenceCarrierId,
  referenceAuthority,
  validateReferenceCarrier,
} from './employee-panels-reference-carrier';
import type { NativePanelsHostBudget } from './employee-panels-reference-carrier';
import type { writeEmployeePanelsReferenceCarrier } from './employee-panels-reference-carrier';
import { writeEmployeePanelsFixture } from './employee-panels-fixture';
import {
  createReferenceFixture,
  referenceKinds,
  renderReferenceContent,
} from './fixtures/employee-panels/reference';
import { nativeClientModule } from './native-client-module.mjs';
import { installedFixtureComposition } from './installed-profile';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const roots: string[] = [],
  contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

// Captured-shape controls only, not a DOM/layout simulation. The formal file
// reads official native markers outside the wrapper and retains raw frames.
const nativeBudget = (): NativePanelsHostBudget => ({
  tab: { x: 793, y: 38, width: 647, height: 962 },
  panel: { x: 792, y: 0, width: 648, height: 1000 },
  available: { x: 793, y: 38, width: 647, height: 962 },
  clips: [
    {
      rect: { x: 793, y: 38, width: 647, height: 962 },
      css: ['hidden', 'hidden', 'none', 'none', '0px', 'round', 'none'],
    },
  ],
  mode: 'push',
  session: 'native-session-A',
  open: true,
});
it('accepts equal independent native pane and clip budgets', () => {
  expect(compareNativePanelsHostBudget(nativeBudget(), nativeBudget())).toEqual(
    [],
  );
});
it.each([
  'outer-width',
  'outer-height',
  'outer-position',
  'clip',
  'clip-css',
  'missing-tab',
  'empty-clip',
] as const)(
  'rejects %s changes even while both replay wrapper dimensions remain unchanged',
  (mutation) => {
    const actual = nativeBudget(),
      expected = nativeBudget();
    const actualWrapper = { width: 647, height: 962 };
    const expectedWrapper = { ...actualWrapper };
    if (mutation === 'outer-width') expected.tab!.width -= 3;
    else if (mutation === 'outer-height') expected.tab!.height -= 5;
    else if (mutation === 'outer-position') expected.panel!.x += 1;
    else if (mutation === 'clip') expected.available.width -= 2;
    else if (mutation === 'clip-css') expected.clips[0]!.css[0] = 'visible';
    else if (mutation === 'missing-tab') expected.tab = null;
    else expected.available.width = 0;
    expect(actualWrapper).toEqual(expectedWrapper);
    expect(
      compareNativePanelsHostBudget(actual, expected).length,
    ).toBeGreaterThan(0);
  },
);
it('keeps the original 0.5px geometry boundary for the actual native pane', () => {
  const actual = nativeBudget(),
    expected = nativeBudget();
  expected.tab!.width += 0.5;
  expect(compareNativePanelsHostBudget(actual, expected)).toEqual([]);
  expected.tab!.width += 0.001;
  expect(compareNativePanelsHostBudget(actual, expected)).toContain(
    'native tab.width',
  );
});

it('leaves default profile injection unchanged and disables the actual declared product entry only on the independent reference profile', async () => {
  const actual = installedFixtureComposition();
  expect(actual.clientInject).toEqual([
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-api-workspace-controller',
    '@deepseek-ai/dsh-client-ui-workspace',
    '@deepseek-ai/dsh-client-ui-theme',
    '@allrice/dsh-web-composition',
  ]);
  expect(actual.patch).toEqual([]);
  const reference = installedFixtureComposition(true);
  expect(reference.clientInject).not.toContain('@allrice/dsh-web-composition');
  expect(reference.clientInject.at(-1)).toBe(
    '@deepseek-ai/dsh-client-ui-sidebar-right',
  );
  expect(
    createRequire(import.meta.url).resolve(
      reference.clientInject.at(-1)! + '/client',
    ),
  ).toContain('dsh-client-ui-sidebar-right');
  const patches = parse(
    await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'),
  ) as { insert?: { id: string; name: string }[] }[];
  const declared = patches
    .flatMap((item) => item.insert ?? [])
    .find((item) => item.name === '@allrice/dsh-web-composition');
  expect(declared).toBeDefined();
  expect(reference.patch).toEqual([{ id: declared!.id, disabled: true }]);
});

// Attribute-call doubles only: these prove ownership/cleanup calls, not DOM
// layout or CSS behavior. The formal browser file retains those real guards.
const attributes = () => {
  const values = new Map<string, string>();
  return {
    getAttribute: (name: string) => values.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      values.set(name, value);
    },
    removeAttribute: (name: string) => {
      values.delete(name);
    },
  };
};
const documentDouble = () => {
  const styles: {
    dataset: Record<string, string>;
    textContent: string;
    remove(): void;
  }[] = [];
  return {
    documentElement: attributes(),
    body: attributes(),
    head: { append: (style: (typeof styles)[number]) => styles.push(style) },
    createElement: () => {
      const style = {
        dataset: {},
        textContent: '',
        remove() {
          styles.splice(styles.indexOf(style), 1);
        },
      };
      return style;
    },
    styles,
  };
};

it('keeps the four real component constructors and original synthetic state props', () => {
  const types = {
    materials: EnterpriseMaterialsPanel,
    files: WorkbenchFilesPanel,
    experience: EmployeeMemorySidebar,
    workflow: EmployeeCapabilitiesPanel,
  };
  for (const kind of referenceKinds) {
    const element = renderReferenceContent(kind, 'denied', true);
    expect(element.type).toBe(types[kind]);
    expect(element.props.active).toBe(true);
    expect(renderReferenceContent(kind, 'list', false).props.active).toBe(
      false,
    );
  }
  expect(renderReferenceContent('experience', 'denied', true).props.error).toBe(
    '无权访问',
  );
});

it('registers a callable contribution in real Cordis/slot lifetimes and releases its native session hold', async () => {
  const ctx = new Context();
  contexts.push(ctx);
  const { SlotRegistry } = nativeClientModule(
    '@deepseek-ai/dsh-client-ui-renderer',
  );
  new SlotRegistry(ctx);
  // Synthetic declaration and service faces for this unit. No copied native
  // frame, renderer or business owner is used or claimed to be mounted.
  ctx.slots.register(
    {
      name: 'root',
      children: {
        'sidebar.right.pane.tab': {
          kind: 'keyed',
          scope: 'session',
          inject: {
            hooks: {
              tabInfo: () => () => {
                throw Error('Unit never mounts a native renderer');
              },
            },
          },
        },
      },
    },
    ({ renderSlot }: PropsRenderSlots<'sidebar.right.pane.tab'>) => {
      void renderSlot;
      return null;
    },
  );
  const registered: string[] = [],
    released: string[] = [],
    release = vi.fn();
  let mounted: string | undefined, active: string | undefined;
  const list = {
    getSnapshot: () => ({ phase: 'ready' }),
    subscribe: () => () => {},
  };
  ctx.provide('sidebarRightTabs', {
    register: ({ id }: { id: string }) => {
      registered.push(id);
      return () => {
        released.push(id);
      };
    },
  });
  ctx.provide('sidebarRight', {
    mounted: { getSnapshot: () => mounted },
    active: () => (active ? { kind: active } : undefined),
    isExpanded: () => !!active,
    openTab: (id: string) => {
      active = id;
    },
  });
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
  ctx.provide('theme', { setTheme: vi.fn() });
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', documentDouble());
  vi.stubGlobal('location', {
    search: '?kind=files&state=list&theme=light&paneWidth=647&paneHeight=962',
  });
  const fork = ctx.plugin(createReferenceFixture());
  await fork;
  await vi.waitFor(() =>
    expect(window.__allricePanelsReference?.evidence().retainedReady).toBe(
      true,
    ),
  );
  expect(registered).toEqual(
    referenceKinds.map((kind) => 'allrice-employee-panels.' + kind),
  );
  expect(ctx.slots.entries('sidebar.right.pane.tab')).toHaveLength(4);
  const ref = window.__allricePanelsReference!;
  ref.open(['files']);
  expect(ref.evidence().activeKind).toBe('allrice-employee-panels.files');
  expect(() => ref.open(['materials'])).toThrow('inventory');
  await fork.dispose();
  expect(ctx.slots.entries('sidebar.right.pane.tab')).toHaveLength(0);
  expect(released.sort()).toEqual(registered.sort());
  expect(release).toHaveBeenCalledTimes(1);
  expect(window.__allricePanelsReference).toBeUndefined();
});

const codecFixture = () => {
  // Synthetic artifact-codec fixture only. Never accepted by referenceAuthority,
  // passed to a Host/browser, or used as an expected panel.
  const sources = Object.fromEntries(
    Object.entries(panelsRev2Sources).map(([name, sha256]) => [
      'apps/web/app/chatflow/' + name,
      sha256,
    ]),
  );
  sources['apps/web/app/layout.tsx'] = hash('synthetic fixed global source');
  sources['apps/web/app/dsh-upstream/upstream.json'] =
    '364bf6701201ec7fded9903131371d482a1affb31b6997f501f58c7bf5e70fd0';
  const authority = {
    head: panelsRev2Head,
    htmlSha256: hash('synthetic historical identity'),
    metadataSha256: hash('synthetic metadata'),
    sources,
    replaySources: { 'data.ts': hash('same data') },
  };
  const entrySha = hash('synthetic callable entry'),
    lockSha = hash('synthetic lock');
  const contents = {
    javascript: 'synthetic codec JS',
    components: 'synthetic codec CSS',
    globals: 'synthetic codec globals',
  };
  const metadata: Parameters<typeof validateReferenceCarrier>[0] = {
    id: panelsReferenceCarrierId,
    head: panelsRev2Head,
    entrySha256: entrySha,
    lockSha256: lockSha,
    historical: {
      htmlSha256: authority.htmlSha256,
      metadataSha256: authority.metadataSha256,
    },
    replaySources: authority.replaySources,
    sources: Object.entries(sources).map(([path, sha256]) => ({
      path,
      sha256,
    })),
    inputs: [
      ...Object.entries(sources).map(([path, sha256]) => ({
        path,
        sha256,
        origin: 'git-rev2',
      })),
      {
        path: 'packages/dsh-web-composition/tests/fixtures/employee-panels/reference.tsx',
        sha256: entrySha,
        origin: 'reference-fixture',
      },
    ],
    externals: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      '@deepseek-ai/dsh-client-ui-primitives',
      'zod',
    ],
    artifacts: {
      javascript: {
        file: 'panels-reference-carrier.cjs',
        sha256: hash(contents.javascript),
      },
      components: {
        file: 'panels-reference-components.css',
        sha256: hash(contents.components),
      },
      globals: {
        file: 'panels-reference-globals.css',
        sha256: hash(contents.globals),
      },
    },
    cssScope: 'synthetic codec only',
  };
  return { authority, entrySha, lockSha, contents, metadata };
};
it('checks separately identified executable/CSS/source closure and cannot relabel synthetic HTML as historical', () => {
  const x = codecFixture();
  expect(
    validateReferenceCarrier(
      x.metadata,
      x.contents,
      x.authority,
      x.entrySha,
      x.lockSha,
    ),
  ).toBe(x.metadata);
  expect(() =>
    referenceAuthority(
      '<p>synthetic</p>',
      JSON.stringify({
        head: panelsRev2Head,
        htmlSha256: hash('<p>synthetic</p>'),
        sources: x.metadata.sources,
        replaySources: [],
      }),
    ),
  ).toThrow('authority mismatch');
});
it.each([
  'javascript',
  'components',
  'globals',
  'entry',
  'missing-source',
  'duplicate-source',
  'unapproved-source',
  'current-product-input',
] as const)('rejects reference artifact corruption: %s', (mutation) => {
  const x = codecFixture();
  if (['javascript', 'components', 'globals'].includes(mutation))
    x.contents[mutation as keyof typeof x.contents] += 'tampered';
  else if (mutation === 'entry') x.metadata.entrySha256 = hash('wrong entry');
  else if (mutation === 'missing-source') x.metadata.sources.shift();
  else if (mutation === 'duplicate-source')
    x.metadata.sources.push(x.metadata.sources[0]!);
  else if (mutation === 'unapproved-source')
    x.metadata.sources.push({
      path: 'apps/web/current.tsx',
      sha256: hash('wrong'),
    });
  else
    x.metadata.inputs.push({
      path: 'packages/dsh-web-composition/src/employee-panels.tsx',
      sha256: hash('current product'),
      origin: 'locked-npm',
    });
  expect(() =>
    validateReferenceCarrier(
      x.metadata,
      x.contents,
      x.authority,
      x.entrySha,
      x.lockSha,
    ),
  ).toThrow();
});

it('selects only the explicit reference executable and keeps its global CSS/HTML attribute lifetime off the actual branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'allrice-reference-codec-'));
  roots.push(root);
  const reference = {
    id: panelsReferenceCarrierId,
    javascript:
      'module.exports.createReferenceFixture=()=>({inject:[],apply:(ctx)=>{ctx.referenceApplied=true;}});',
    globals: '/* synthetic reference globals */',
    components: '/* synthetic component CSS */',
    metadataSha256: hash('synthetic carrier'),
    metadata: { entrySha256: hash('synthetic entry'), artifacts: {} },
  } as Awaited<ReturnType<typeof writeEmployeePanelsReferenceCarrier>>;
  const file = await writeEmployeePanelsFixture(root, reference),
    client = await readFile(file, 'utf8');
  const load = (search: string, document = documentDouble()) => {
    let fixture: ReturnType<typeof createReferenceFixture>;
    const requested: string[] = [];
    runInNewContext(client, {
      document,
      location: { search },
      URLSearchParams,
      window: {
        __ModuleLoader__: {
          load(module: {
            factory(require: (name: string) => unknown): typeof fixture;
          }) {
            fixture = module.factory((name) => {
              requested.push(name);
              return {
                react: React,
                'react/jsx-runtime': Jsx,
                '@deepseek-ai/dsh-client-ui-primitives': Primitives,
                zod: Zod,
                '@allrice/dsh-web-composition': { bindEmployeePanels: vi.fn() },
              }[name];
            });
          },
        },
      },
    });
    return { fixture: fixture!, requested, document };
  };
  for (const previous of [null, '', 'existing']) {
    const document = documentDouble();
    if (previous !== null)
      document.documentElement.setAttribute('data-allrice-framework', previous);
    const selected = load('?allricePanelsReference=' + reference.id, document),
      cleanup: (() => void)[] = [];
    const ctx = {
      referenceApplied: false,
      effect: (setup: () => () => void) => {
        cleanup.push(setup());
      },
    };
    selected.fixture.apply(ctx as unknown as Context);
    expect(selected.requested).toEqual([]);
    expect(ctx.referenceApplied).toBe(true);
    expect(document.styles[0]!.textContent).toBe(
      reference.globals + '\n' + reference.components,
    );
    expect(
      document.documentElement.getAttribute('data-allrice-framework'),
    ).toBe('v2');
    cleanup.reverse().forEach((dispose) => dispose());
    expect(document.styles).toHaveLength(0);
    expect(
      document.documentElement.getAttribute('data-allrice-framework'),
    ).toBe(previous);
  }
  expect(load('').requested).toContain('@allrice/dsh-web-composition');
  expect(() => load('?allricePanelsReference=unknown')).toThrow(
    'Unknown reference carrier',
  );
});
