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
  const route = (name: string, body: string) => {
    files[`apps/web/app/api/${name}/route.ts`] =
      `import { sql } from '../../../../../lib/db.ts';\n` +
      `import * as reads from '../../../../../lib/reads.ts';\n` +
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

  beforeAll(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'row-lock-audit-')));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(project, path)), { recursive: true });
      await writeFile(join(project, path), text);
    }
    const report = createRowLockAudit(project).routeLocks(
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
        'reassigned-parameter',
        'switch-break',
        'unknown-object',
        'unsafe-const',
        'unsafe-element',
        'unsafe-string',
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
});
