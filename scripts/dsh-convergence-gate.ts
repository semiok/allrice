/** MET-210 #4: DSH wrappers only shrink, unless an approved need is recorded. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { getDatabase } from '../packages/database/src/core/client.ts';

export const BASELINE_PATH = 'scripts/dsh-convergence-gate.baseline.ts';
export const INITIAL_APPROVAL = 'baseline 2026-10-27';
export const CATEGORIES = [
  '门卫',
  '账本',
  '存储后端',
  '租约',
  '业务工具',
] as const;
export const TABLE_PREFIXES = [
  'allrice_native_',
  'allrice_assistant_',
  'allrice_dsh_',
] as const;
export const EXACT_TABLE_NAMES = [
  'allrice_brand_content_reminders',
  'allrice_brand_native_reminder_targets',
] as const;
export const KINDS = ['table', 'patch', 'private-interface'] as const;
export type ItemKind = (typeof KINDS)[number];
export type BaselineEntry = {
  kind: ItemKind;
  id: string;
  category: (typeof CATEGORIES)[number] | '待删';
  basis: string;
  approvedBy: string;
};
export type Inventory = Partial<Record<ItemKind, readonly string[]>>;
const key = (entry: Pick<BaselineEntry, 'kind' | 'id'>) =>
  `${entry.kind}: ${entry.id}`;
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** No I/O. Omitted inventory kinds are checked by the other CI step. */
export function checkBaseline(
  actual: Inventory,
  baseline: readonly BaselineEntry[],
  before: readonly BaselineEntry[] | null,
): string[] {
  const problems: string[] = [];
  const entries = new Set<string>();
  const previous = new Map(before?.map((entry) => [key(entry), entry]));
  for (const entry of baseline) {
    const label = key(entry);
    if (!KINDS.includes(entry.kind) || !nonempty(entry.id))
      problems.push(`${label}: kind/id 无效`);
    if (entries.has(label)) problems.push(`${label}: 基线重复登记`);
    entries.add(label);
    const prior = previous.get(label);
    const leavingPendingDeletion =
      prior?.category === '待删' && entry.category !== '待删';
    const initial =
      entry.approvedBy === INITIAL_APPROVAL &&
      (before === null || prior?.approvedBy === INITIAL_APPROVAL) &&
      !leavingPendingDeletion;
    if (
      (!(CATEGORIES as readonly string[]).includes(entry.category) &&
        !(initial && entry.category === '待删')) ||
      (entry.category === '业务工具' && entry.kind !== 'patch')
    )
      problems.push(
        `${label}: category 必须是门卫 / 账本 / 存储后端 / 租约；业务工具仅限 patch；只有初始存量可标待删`,
      );
    if (!nonempty(entry.basis))
      problems.push(
        `${label}: 缺少 basis，写明 DSH 做不了的 SaaS 判断或业务工具依据`,
      );
    if (
      !initial &&
      (!nonempty(entry.approvedBy) ||
        !/^\d{4}-\d{2}-\d{2}\s+\S[\s\S]*$/.test(entry.approvedBy) ||
        (leavingPendingDeletion && entry.approvedBy === prior?.approvedBy))
    )
      problems.push(
        `${label}: approvedBy 必须有批准日期和非空出处（MET 评论链接、PR 链接、原话或任务说明）；新增项不能冒用 ${INITIAL_APPROVAL}，从待删改为保留类别必须更新批准记录`,
      );
  }
  for (const kind of KINDS) {
    const items = actual[kind];
    if (!items) continue;
    const observed = new Set(items);
    const recorded = new Set(
      baseline.filter((entry) => entry.kind === kind).map((entry) => entry.id),
    );
    for (const id of observed)
      if (!recorded.has(id))
        problems.push(
          `${kind}: ${id}: 新增未登记；先取得用户批准，再在 ${BASELINE_PATH} 加 category（四类之一，patch 也可为业务工具）、basis（DSH 做不了的原因或业务工具依据）、approvedBy（日期和非空出处）`,
        );
    for (const id of recorded)
      if (!observed.has(id))
        problems.push(
          `${kind}: ${id}: 实际已不存在；请从 ${BASELINE_PATH} 删除这一行`,
        );
  }
  return problems;
}

/** Read both revisions as literal data; never execute the base revision. */
export function parseBaseline(source: string): BaselineEntry[] {
  const file = ts.createSourceFile(
    BASELINE_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(file) !== 'baseline') continue;
      if (
        !declaration.initializer ||
        !ts.isArrayLiteralExpression(declaration.initializer)
      )
        break;
      return declaration.initializer.elements.map((element) => {
        if (!ts.isObjectLiteralExpression(element))
          throw Error('基线条目必须是对象字面量');
        const entry: Record<string, string> = {};
        for (const property of element.properties) {
          if (
            !ts.isPropertyAssignment(property) ||
            !ts.isIdentifier(property.name) ||
            !ts.isStringLiteral(property.initializer)
          )
            throw Error('基线字段必须是具名的字符串字面量');
          if (property.name.text in entry) throw Error('基线字段重复');
          entry[property.name.text] = property.initializer.text;
        }
        // Missing fields are diagnosed by checkBaseline with the item identity.
        return entry as BaselineEntry;
      });
    }
  }
  throw Error(`${BASELINE_PATH}: 找不到 baseline 数组字面量`);
}

export function readStaticInventory(root: string): Inventory {
  const read = (path: string) =>
    JSON.parse(readFileSync(join(root, path), 'utf8'));
  const patches = read('apps/worker/dsh/patch-ledger.json').patches;
  const interfaces = read(
    'apps/worker/dsh/compatibility.json',
  ).privateInterfaces;
  if (!Array.isArray(patches) || !Array.isArray(interfaces))
    throw Error(
      'patch-ledger.patches 和 compatibility.privateInterfaces 必须是数组',
    );
  const interfaceIds = new Set<string>();
  return {
    patch: patches.map((item) => {
      if (!nonempty(item?.id)) throw Error('patch-ledger 适配项缺少 id');
      return item.id;
    }),
    'private-interface': interfaces.map((item) => {
      if (!nonempty(item?.id) || !nonempty(item?.upstreamInterface))
        throw Error('privateInterfaces 条目缺少 id/upstreamInterface');
      if (interfaceIds.has(item.id))
        throw Error(`compatibility.privateInterfaces 重复 id: ${item.id}`);
      interfaceIds.add(item.id);
      return `${item.id}: ${item.upstreamInterface}`;
    }),
  };
}

type Database = ReturnType<typeof getDatabase>;
export function openDatabase(url: string): Database {
  // postgres belongs to the database workspace; validate needs no DB connection.
  const postgres = createRequire(
    new URL('../packages/database/package.json', import.meta.url),
  )('postgres');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export async function readNativeTables(sql: Database): Promise<string[]> {
  // Scalar parameters also work on the CLI's first query, before array type discovery.
  let matches = sql`false`;
  for (const prefix of TABLE_PREFIXES)
    matches = sql`${matches} or starts_with(tablename, ${prefix})`;
  for (const name of EXACT_TABLE_NAMES)
    matches = sql`${matches} or tablename = ${name}`;
  const rows = await sql<{ name: string }[]>`
    select tablename as name from pg_catalog.pg_tables
    where schemaname = current_schema()
      and (${matches})
    order by tablename`;
  return rows.map((row) => row.name);
}

export async function runGate(
  root: string,
  argv: readonly string[],
): Promise<number> {
  let base: string | undefined;
  let tables = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--tables') tables = true;
    else if (
      argv[index] === '--base' &&
      argv[index + 1] &&
      !argv[index + 1]!.startsWith('-')
    )
      base = argv[++index];
    else {
      console.error(
        'usage: node --import tsx scripts/dsh-convergence-gate.ts [--tables] [--base <commit>]',
      );
      return 2;
    }
  }
  try {
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    base = git([
      'rev-parse',
      '--verify',
      `${base ?? git(['merge-base', 'HEAD', 'origin/main'])}^{commit}`,
    ]);
    const before = git(['ls-tree', '--name-only', base, '--', BASELINE_PATH])
      ? parseBaseline(git(['show', `${base}:${BASELINE_PATH}`]))
      : null;
    const baseline = parseBaseline(
      readFileSync(join(root, BASELINE_PATH), 'utf8'),
    );
    let actual: Inventory;
    if (tables) {
      if (!process.env.DATABASE_URL)
        throw Error('--tables 需要显式的 DATABASE_URL（已完成迁移的库）');
      const sql = openDatabase(process.env.DATABASE_URL);
      try {
        actual = { table: await readNativeTables(sql) };
      } finally {
        await sql.end({ timeout: 5 });
      }
    } else actual = readStaticInventory(root);
    const problems = checkBaseline(actual, baseline, before);
    console.log(
      `DSH convergence: ${Object.entries(actual)
        .map(([kind, ids]) => `${kind}=${ids.length}`)
        .join(' ')} base=${base.slice(0, 12)}`,
    );
    for (const problem of problems) console.error(problem);
    return problems.length ? 1 : 0;
  } catch (error) {
    console.error(
      `DSH convergence: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runGate(process.cwd(), process.argv.slice(2));
