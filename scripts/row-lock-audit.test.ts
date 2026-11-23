import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  reviewedGetLocks,
  reviewedUnresolvedCalls,
  writingGetCalls,
  writingGetRoutes,
} from './row-lock-audit.allowlist.ts';
import {
  createRowLockAudit,
  type ReachedLock,
  type RouteLockReport,
} from './row-lock-audit.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * MET-210 #4 gate: SQL reached from an `apps/web/app/api/**` GET handler must
 * not take row locks. Read paths use plain snapshot reads; shared helpers take
 * a `lock` argument that read callers pass as `false`.
 */
describe('GET route handlers take no row locks', () => {
  let report: RouteLockReport;
  beforeAll(() => {
    // Builds the apps/web TypeScript program once: about 5–10 s, ~1 GB.
    report = createRowLockAudit(root).routeLocks(
      ['GET'],
      undefined,
      writingGetCalls,
    );
  }, 180_000);
  const writing = new Set(writingGetRoutes.map((entry) => entry.route));
  const reviewed = (site: ReachedLock) =>
    reviewedGetLocks.find(
      (entry) =>
        entry.file === site.file &&
        entry.owner === site.owner &&
        entry.clause === site.clause,
    );

  it('reaches no row-lock clause outside reviewed writing routes and calls', () => {
    const violations = report.reached
      .map((site) => ({
        ...site,
        routes: site.routes.filter(
          (route) => !writing.has(route.replace(/ GET$/, '')),
        ),
      }))
      .filter((site) => site.routes.length && !reviewed(site))
      .map(
        (site) =>
          `${site.file}:${site.line} \`${site.clause}\` in ${site.owner}, from ${site.routes.length} GET route(s):\n    ${site.chain.join('\n    -> ')}`,
      );
    expect(violations).toEqual([]);
  });

  it('follows every interface-typed call on GET paths or has it reviewed', () => {
    const known = new Set(reviewedUnresolvedCalls.map((entry) => entry.target));
    expect(report.unresolved.filter((target) => !known.has(target))).toEqual(
      [],
    );
  });

  it('keeps the allowlists current', () => {
    const routes = new Set(
      report.reached.flatMap((site) =>
        site.routes.map((route) => route.replace(/ GET$/, '')),
      ),
    );
    expect(
      writingGetRoutes.filter((entry) => !routes.has(entry.route)),
    ).toEqual([]);
    expect(
      reviewedGetLocks.filter(
        (entry) =>
          !report.reached.some(
            (site) =>
              site.file === entry.file &&
              site.owner === entry.owner &&
              site.clause === entry.clause,
          ),
      ),
    ).toEqual([]);
    expect(
      reviewedUnresolvedCalls.filter(
        (entry) => !report.unresolved.includes(entry.target),
      ),
    ).toEqual([]);
    expect(
      writingGetCalls.filter(
        (entry) =>
          !report.stopped.includes(
            `${entry.route} ${entry.file} ${entry.owner}`,
          ),
      ),
    ).toEqual([]);
  });
});

/** The analyzer itself: each pattern below once let a read-path lock through. */
describe('row-lock audit follows the call shapes it claims to', () => {
  let project: string;
  let report: RouteLockReport;
  let reached: string[];
  let unresolved: string[];
  const files: Record<string, string> = {
    'apps/web/tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        module: 'ESNext',
        moduleResolution: 'Bundler',
        allowImportingTsExtensions: true,
        noEmit: true,
        types: [],
      },
      include: ['../../**/*.ts'],
    }),
    // The SQL client is an outside package, like postgres.js.
    'node_modules/fakepg/package.json': JSON.stringify({
      name: 'fakepg',
      version: '1.0.0',
      types: 'index.d.ts',
    }),
    'node_modules/fakepg/index.d.ts': `export type Sql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  unsafe(text: string): Promise<unknown[]>;
};`,
    'lib/db.ts': `import type { Sql } from 'fakepg';
export declare const sql: Sql;`,
    'lib/diagnostics.d.mts': `export interface Diagnostics {
  phase<T>(stage: string, body: () => T | PromiseLike<T>): Promise<T>;
}
export function createDiagnostics(): Diagnostics;`,
    'lib/diagnostics.mjs': `export const createDiagnostics = () => ({
  phase: async (stage, body) => body(),
});`,
    'lib/reads.ts': `import { sql } from './db.ts';
export async function readRun(lock = true) {
  await sql\`select * from runs \${lock ? sql\`for share\` : sql\`\`}\`;
}
export async function readOptions({ lock = true }: { lock?: boolean } = {}) {
  await sql\`select 1 \${lock ? sql\`for share\` : sql\`\`}\`;
}
export async function reassigned(lock = false) {
  lock = true;
  await sql\`select 1 \${lock ? sql\`for update\` : sql\`\`}\`;
}
export async function renew() {
  await sql\`update runs set lease=now() where id in (select id from runs for update)\`;
}
export async function unsafeLock() {
  await sql.unsafe('select * from runs for update');
}
export const helpers = {
  async read() {
    await sql\`select * from runs for share\`;
  },
};
async function aliasTarget() {
  await sql\`select * from runs for share\`;
}
export const alias = aliasTarget;
export interface Store {
  read(): Promise<void>;
}
export function createStore(): Store {
  return {
    async read() {
      await sql\`select * from stores for share\`;
    },
  };
}`,
  };
  files['lib/factories.ts'] = `import { sql } from './db.ts';
interface Store { read(): Promise<void>; }
interface Owner { open(): Promise<void>; reauthorize(): Promise<void>; close(): Promise<void>; }
interface Attachment { acquire(): Promise<Owner>; }
interface Ports { binding?(): Promise<void>; store?: Store; attachment?: Attachment; }
export const injected: Ports = {
  async binding() { await sql\`select * from bindings for share\`; },
  store: { async read() { await sql\`select * from stores for share\`; } },
  attachment: { async acquire() {
    await sql\`select * from attachments for share\`;
    return {
      async open() { await sql\`select * from objects for share\`; },
      async reauthorize() { await sql\`select * from objects for share\`; },
      async close() {},
    };
  } },
};
export function cold(ports: Ports = {}) {
  async function serve() {
    if (!ports.binding || !ports.store || !ports.attachment) return;
    await ports.binding(); await ports.store.read();
    const owner = await ports.attachment.acquire();
    await owner.open(); await owner.reauthorize(); await owner.close();
  }
  return { history: () => serve(), download: () => serve() };
}
export function shadow(ports: Ports = {}) {
  void ports.binding;
  async function serve(ports: Ports) {
    if (!ports.binding) return;
    await sql\`select * from shadowed for share\`;
  }
  return { history: () => serve(injected) };
}
export function reentry(ports: Ports = {}) {
  async function serve(again: boolean) {
    if (again) return reentry(injected).history(false);
    if (!ports.binding) return;
    await sql\`select * from reentered for share\`;
  }
  return { history: (again = true) => serve(again) };
}
interface AsyncLiteral { close(): Promise<void>; }
export async function asyncLiteral(): Promise<AsyncLiteral> {
  return { async close() { await sql\`select * from async_rows for share\`; } };
}
interface ClassOnly { classRead(): Promise<void>; }
class ClassStore implements ClassOnly {
  async classRead() { await sql\`select * from class_rows for share\`; }
}
export function classOnly(): ClassOnly { return new ClassStore(); }
interface Opaque { opaqueClose(): Promise<void>; }
export declare function opaque(): Promise<Opaque>;
// A harmless async implementation of the SAME interface is not evidence for
// a class, opaque factory, mixed return, or escaped receiver.
interface SharedStore { sharedRead(): Promise<void>; }
export async function harmless(): Promise<SharedStore> {
  return { async sharedRead() {} };
}
class LockedSharedStore implements SharedStore {
  async sharedRead() { await sql\`select * from shared_class_rows for share\`; }
}
export function sharedClass(): SharedStore { return new LockedSharedStore(); }
export declare function sharedOpaque(): Promise<SharedStore>;
export function sharedMixed(flag: boolean): SharedStore {
  if (flag) return { async sharedRead() {} };
  return new LockedSharedStore();
}
function liveFlag() { return true; }
export async function capture(ports: { enabled?: boolean } = {}) {
  const enabled = ports.enabled;
  async function read(enabled: boolean) {
    if (!enabled) return;
    await sql\`select * from shadowed_parameter for share\`;
  }
  await read(liveFlag());
}
export async function capturePattern(ports: { enabled?: boolean } = {}) {
  const enabled = ports.enabled;
  async function read({ enabled }: { enabled: boolean }) {
    if (!enabled) return;
    await sql\`select * from shadowed_pattern for share\`;
  }
  await read({ enabled: liveFlag() });
}
export async function captureLocal(ports: { enabled?: boolean } = {}) {
  const enabled = ports.enabled;
  async function read() {
    const enabled = liveFlag();
    if (!enabled) return;
    await sql\`select * from shadowed_local for share\`;
  }
  await read();
}
export function escapedDefault(ports: { enabled?: boolean } = {}) {
  Object.assign(ports.valueOf(), { enabled: true });
  async function read() {
    if (!ports.enabled) return;
    await sql\`select * from escaped_default for share\`;
  }
  return { history: () => read() };
}
export async function captureClass(ports: { enabled?: boolean } = {}) {
  const enabled = ports.enabled;
  const reader = class enabled {
    static async read() {
      if (enabled === undefined) return;
      await sql\`select * from class_name_shadow for share\`;
    }
  };
  await reader.read();
}
interface AliasStore { aliasRead(): Promise<void>; }
export function constAlias(): AliasStore {
  const store: AliasStore = { async aliasRead() {
    await sql\`select * from const_alias_own for share\`;
  } };
  return store;
}
export function unrelatedAlias(): AliasStore {
  return { async aliasRead() {
    await sql\`select * from wrong_alias_producer for share\`;
  } };
}
export function aliasMutation(): AliasStore {
  const store: AliasStore = { async aliasRead() {} };
  store.aliasRead = async () => { await sql\`select * from mutated_alias for share\`; };
  return store;
}
export function aliasEscape(): AliasStore {
  const store: AliasStore = { async aliasRead() {} };
  escapeAlias(store);
  return store;
}
declare function escapeAlias(store: AliasStore): void;
declare function escape(ports: Ports): void;
`;
  for (const [name, change] of Object.entries({
    mutation: 'ports.binding = injected.binding;',
    escape: 'escape(ports);',
    alias: 'const alias = ports; alias.binding = injected.binding;',
    reassignment: 'ports = injected;',
    wrapped: '(ports.binding as Ports["binding"]) = injected.binding;',
  }))
    files['lib/factories.ts'] += `
export function ${name}(ports: Ports = {}) {
  ${change}
  async function serve() {
    if (!ports.binding) return;
    await sql\`select * from ${name}_rows for share\`;
  }
  return { history: () => serve() };
}`;
  for (const [name, change] of Object.entries({
    arrayWrite: '[ports.enabled] = [true];',
    objectWrite: '({ enabled: ports.enabled } = { enabled: true });',
    forOfWrite: 'for (ports.enabled of [true]) {}',
  }))
    files['lib/factories.ts'] += `
export function ${name}(ports: { enabled?: boolean } = {}) {
  ${change}
  async function read() {
    if (!ports.enabled) return;
    await sql\`select * from ${name}_own_rows for share\`;
  }
  return { history: () => read() };
}`;
  const route = (name: string, body: string) => {
    files[`apps/web/app/api/${name}/route.ts`] =
      `import { sql } from '../../../../../lib/db.ts';\n` +
      `import * as reads from '../../../../../lib/reads.ts';\n` +
      `import * as factories from '../../../../../lib/factories.ts';\n` +
      `void sql; void reads;\n${body}`;
  };
  // Must be reported.
  route(
    'direct',
    'export async function GET() { await sql`select * from runs for share`; }',
  );
  route(
    'unknown-object',
    "export async function GET() { const o = JSON.parse('{}') as { lock?: boolean }; await reads.readOptions(o); }",
  );
  route(
    'reassigned-parameter',
    'export async function GET() { await reads.reassigned(false); }',
  );
  route(
    'switch-break',
    `export async function GET(request: Request) {
  switch (request.method) {
    case 'GET':
      break;
    case 'POST':
      return new Response();
  }
  await sql\`select * from runs for share\`;
}`,
  );
  route(
    'unsafe-string',
    'export async function GET() { await reads.unsafeLock(); }',
  );
  route(
    'element-access',
    "export async function GET() { await reads.helpers['read'](); }",
  );
  route(
    'dynamic-key',
    `export async function GET(request: Request) {
  const pick = { fast: () => true, slow: reads.unsafeLock };
  await pick[new URL(request.url).searchParams.get('k') as keyof typeof pick]();
}`,
  );
  route(
    'conditional-break',
    `export async function GET(request: Request) {
  const skip = new URL(request.url).searchParams.has('skip');
  switch (request.method) {
    case 'GET':
      if (skip) break;
    // falls through
    case 'POST':
      await sql\`select * from runs for share\`;
      return new Response();
  }
  return new Response();
}`,
  );
  route(
    'unsafe-const',
    "const tail = 'for update';\nexport async function GET() { await sql.unsafe(`select * from runs ${tail}`); }",
  );
  route(
    'unsafe-element',
    "export async function GET() { await sql['unsafe']('select * from runs for update'); }",
  );
  // Must be unresolved, not silently safe.
  route(
    'unsafe-dynamic',
    'export async function GET(request: Request) { const tail = new URL(request.url).search; await sql.unsafe(`select * from runs ${tail}`); }',
  );
  route(
    'client-dynamic-key',
    "export async function GET(request: Request) { const name = new URL(request.url).search as 'unsafe'; await sql[name]('select 1'); }",
  );
  route('alias', 'export async function GET() { await reads.alias(); }');
  route(
    'interface-factory',
    'export async function GET() { await reads.createStore().read(); }',
  );
  route(
    'interface-phase-block',
    `import { createDiagnostics } from '../../../../../lib/diagnostics.mjs';
export async function GET() {
  await createDiagnostics().phase('authorize', async () => {
    await sql\`select * from runs for share\`;
  });
}`,
  );
  route(
    'interface-phase-expression',
    `import { createDiagnostics } from '../../../../../lib/diagnostics.mjs';
export async function GET() {
  await createDiagnostics().phase('authorize', () => sql\`select * from runs for share\`);
}`,
  );
  route(
    'barrier-and-read',
    'export async function GET() { await reads.renew(); await reads.readRun(); }',
  );
  // Must not be reported.
  route('barrier-only', 'export async function GET() { await reads.renew(); }');
  route(
    'pinned-false',
    'export async function GET() { await reads.readRun(false); }\nexport async function POST() { await reads.readRun(); }',
  );
  route(
    'shared-handler',
    `async function handle(write: boolean) {
  if (write) await reads.readRun();
  else await reads.readRun(false);
}
export const GET = () => handle(false);
export const POST = () => handle(true);`,
  );
  route(
    'object-literal-false',
    'export async function GET() { await reads.readOptions({ lock: false }); }',
  );
  route(
    'factory-default',
    'export const GET = () => factories.cold().history();',
  );
  route(
    'factory-local-default',
    'export async function GET() { const h = factories.cold(); await h.download(); }',
  );
  for (const [name, argument] of Object.entries({
    injected: 'factories.injected',
    unknown: 'JSON.parse("{}")',
    explicit: '{}',
  }))
    route(
      `factory-${name}`,
      `export const GET = () => factories.cold(${argument}).history();`,
    );
  for (const name of [
    'mutation',
    'escape',
    'alias',
    'reassignment',
    'shadow',
    'reentry',
    'wrapped',
  ])
    route(
      `factory-${name}`,
      `export const GET = () => factories.${name}().history();`,
    );
  route(
    'factory-async-literal',
    'export async function GET() { const h = await factories.asyncLiteral(); await h.close(); }',
  );
  route(
    'factory-class-unknown',
    'export const GET = () => factories.classOnly().classRead();',
  );
  route(
    'factory-async-unknown',
    'export async function GET() { const h = await factories.opaque(); await h.opaqueClose(); }',
  );

  for (const name of ['arrayWrite', 'objectWrite', 'forOfWrite'])
    route(
      `factory-${name}`,
      `export const GET = () => factories.${name}().history();`,
    );
  for (const name of ['capture', 'capturePattern', 'captureLocal'])
    route(`factory-${name}`, `export const GET = () => factories.${name}();`);
  route(
    'factory-shared-class',
    'export const GET = () => factories.sharedClass().sharedRead();',
  );
  route(
    'factory-shared-opaque',
    'export async function GET() { const h = await factories.sharedOpaque(); await h.sharedRead(); }',
  );
  route(
    'factory-shared-mixed',
    'export async function GET() { await factories.sharedMixed(JSON.parse("true")).sharedRead(); }',
  );

  route(
    'factory-escaped-default',
    'export const GET = () => factories.escapedDefault().history();',
  );
  route(
    'factory-capture-class',
    'export const GET = () => factories.captureClass();',
  );
  for (const name of ['constAlias', 'aliasMutation', 'aliasEscape'])
    route(
      `factory-${name}`,
      `export const GET = () => factories.${name}().aliasRead();`,
    );

  beforeAll(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'row-lock-audit-')));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(project, path)), { recursive: true });
      await writeFile(join(project, path), text);
    }
    report = createRowLockAudit(project).routeLocks(
      ['GET'],
      undefined,
      ['barrier-and-read', 'barrier-only'].map((name) => ({
        route: `apps/web/app/api/${name}/route.ts`,
        file: 'lib/reads.ts',
        owner: 'renew',
      })),
    );
    reached = [
      ...new Set(
        report.reached.flatMap((site) =>
          site.routes.map((entry) => entry.split('/')[4]!),
        ),
      ),
    ].sort();
    unresolved = report.unresolved;
  }, 60_000);
  afterAll(async () => {
    if (project?.includes('row-lock-audit-'))
      await rm(project, { recursive: true, force: true });
  });

  it('reports every reachable lock and prunes only literal read flags', () => {
    expect(reached).toEqual(
      [
        'alias',
        'barrier-and-read',
        'conditional-break',
        'direct',
        'dynamic-key',
        'element-access',
        'interface-factory',
        'interface-phase-block',
        'interface-phase-expression',
        'reassigned-parameter',
        'switch-break',
        'unknown-object',
        'unsafe-const',
        'unsafe-element',
        'unsafe-string',
        ...[
          'injected',
          'unknown',
          'explicit',
          'mutation',
          'escape',
          'alias',
          'reassignment',
          'shadow',
          'reentry',
          'async-literal',
          'wrapped',
          'arrayWrite',
          'objectWrite',
          'forOfWrite',
          'capture',
          'capturePattern',
          'captureLocal',
          'escaped-default',
          'capture-class',
          'constAlias',
          'aliasMutation',
          'aliasEscape',
        ].map((name) => `factory-${name}`),
      ].sort(),
    );
  });

  it('reports SQL it cannot read as unresolved instead of safe', () => {
    expect(unresolved).toEqual(
      expect.arrayContaining([
        'apps/web/app/api/unsafe-dynamic/route.ts unsafe(<dynamic SQL>)',
        'apps/web/app/api/client-dynamic-key/route.ts [<dynamic key>]()',
      ]),
    );
    expect(
      unresolved.filter((entry) => /unsafe-(?:const|element)\//.test(entry)),
    ).toEqual([]);
  });

  it('prunes only proven unmodified absent factory ports, including a local returned handler', () => {
    expect(reached).not.toContain('factory-default');
    expect(reached).not.toContain('factory-local-default');
    const coldLocks = report.reached.filter(
      (site) => site.file === 'lib/factories.ts',
    );
    for (const name of ['injected', 'unknown', 'explicit'])
      expect(
        coldLocks
          .filter((site) =>
            site.routes.includes(
              `apps/web/app/api/factory-${name}/route.ts GET`,
            ),
          )
          .map((site) => site.owner),
      ).toEqual(
        expect.arrayContaining([
          'binding',
          'read',
          'acquire',
          'open',
          'reauthorize',
        ]),
      );
  });

  it('keeps unsupported class and async implementations unresolved', () => {
    expect(unresolved).toEqual(
      expect.arrayContaining([
        'lib/factories.ts classRead',
        'lib/factories.ts opaqueClose',
      ]),
    );
  });

  it('keeps each destructuring or loop write and shadowed unknown argument SQL reachable', () => {
    for (const name of ['arrayWrite', 'objectWrite', 'forOfWrite']) {
      // A different injected implementation cannot satisfy this regression.
      const ownLine =
        files['lib/factories.ts']!.split('\n').findIndex((line) =>
          line.includes(`${name}_own_rows`),
        ) + 1;
      expect(
        report.reached.some(
          (site) =>
            site.file === 'lib/factories.ts' &&
            site.line === ownLine &&
            site.routes.includes(
              `apps/web/app/api/factory-${name}/route.ts GET`,
            ),
        ),
      ).toBe(true);
    }
    for (const [name, table] of [
      ['capture', 'shadowed_parameter'],
      ['capturePattern', 'shadowed_pattern'],
      ['captureLocal', 'shadowed_local'],
    ]) {
      const ownLine =
        files['lib/factories.ts']!.split('\n').findIndex((line) =>
          line.includes(`from ${table} for share`),
        ) + 1;
      expect(
        report.reached.some(
          (site) =>
            site.file === 'lib/factories.ts' &&
            site.line === ownLine &&
            site.routes.includes(
              `apps/web/app/api/factory-${name}/route.ts GET`,
            ),
        ),
      ).toBe(true);
    }
  });

  it('does not use an unrelated async literal to resolve a shared class or opaque interface', () => {
    // Audit each route independently so one unresolved route cannot hide a
    // false-safe result on another route with the same interface signature.
    const audit = createRowLockAudit(project);
    for (const name of ['class', 'opaque', 'mixed']) {
      const own = audit.routeLocks(['GET'], `factory-shared-${name}/`);
      expect(own.entries).toBe(1);
      expect(own.unresolved).toContain('lib/factories.ts sharedRead');
    }
  });

  it('keeps receiver-returning calls and named class-expression bindings conservative', () => {
    for (const [name, table] of [
      ['escaped-default', 'escaped_default'],
      ['capture-class', 'class_name_shadow'],
    ]) {
      const ownLine =
        files['lib/factories.ts']!.split('\n').findIndex((line) =>
          line.includes(`from ${table} for share`),
        ) + 1;
      expect(
        report.reached.some(
          (site) =>
            site.file === 'lib/factories.ts' &&
            site.line === ownLine &&
            site.routes.includes(
              `apps/web/app/api/factory-${name}/route.ts GET`,
            ),
        ),
      ).toBe(true);
    }
  });

  it('associates only unmodified non-escaping returned literal aliases', () => {
    const audit = createRowLockAudit(project);
    const actual = audit.routeLocks(['GET'], 'factory-constAlias/');
    const ownLine =
      files['lib/factories.ts']!.split('\n').findIndex((line) =>
        line.includes('from const_alias_own for share'),
      ) + 1;
    expect(actual.entries).toBe(1);
    expect(actual.unresolved).not.toContain('lib/factories.ts aliasRead');
    expect(
      actual.reached.map((site) => ({ file: site.file, line: site.line })),
    ).toEqual([{ file: 'lib/factories.ts', line: ownLine }]);
    for (const name of ['aliasMutation', 'aliasEscape']) {
      const uncertain = audit.routeLocks(['GET'], `factory-${name}/`);
      expect(uncertain.entries).toBe(1);
      expect(uncertain.unresolved).toContain('lib/factories.ts aliasRead');
    }
  });

  it('keeps inline callback locks visible after exact review of an unresolved interface call', () => {
    // Exact review filters unresolved targets after analysis, never traversal.
    const reviewed = new Set(['lib/diagnostics.d.mts phase']);
    expect(unresolved.filter((target) => reviewed.has(target))).toEqual([
      ...reviewed,
    ]);
    expect(
      report.reached
        .filter((site) => site.clause === 'for share')
        .flatMap((site) => site.routes),
    ).toEqual(
      expect.arrayContaining([
        'apps/web/app/api/interface-phase-block/route.ts GET',
        'apps/web/app/api/interface-phase-expression/route.ts GET',
      ]),
    );
  });
});
