import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { baseline } from './user-text-regex-gate.baseline.ts';
import {
  BASELINE_PATH,
  baselineChange,
  checkBaseline,
  parseBaseline,
  productFiles,
  runGate,
  scanUserTextMatches,
  type BaselineEntry,
  type BaselineKind,
  type ScanReport,
} from './user-text-regex-gate.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
// Written out so no escape in these fixtures is decoded before the scan sees it.
const BS = String.fromCharCode(92);

/**
 * MET-210 #2 gate (MET-220 R1): product code may not add a match on the
 * user's wording outside the baseline, and the baseline lists only what is
 * still in the code.
 */
describe('wording matches stay within the baseline', () => {
  let report: ScanReport;
  beforeAll(() => {
    report = scanUserTextMatches(root);
  }, 60_000);

  it('adds no site outside the baseline and keeps every exemption well formed', () => {
    const check = checkBaseline(report, baseline);
    expect(
      check.added.map(
        (site) => `${site.file}:${site.line} ${site.owner} ${site.text}`,
      ),
    ).toEqual([]);
    expect(
      check.problems.map(
        (problem) => `${problem.file}:${problem.line} ${problem.problem}`,
      ),
    ).toEqual([]);
  });

  it('lists only sites still in the code', () => {
    expect(checkBaseline(report, baseline).stale).toEqual([]);
  });

  it('reads the baseline file as data exactly as TypeScript evaluates it', async () => {
    const source = await readFile(join(root, BASELINE_PATH), 'utf8');
    expect(parseBaseline(source)).toEqual(baseline);
  });
});

async function writeTree(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

/** The scanner itself: each shape below is one the gate claims to catch. */
describe('the scan reports the shapes it claims to', () => {
  let project: string;
  let report: ScanReport;
  const files: Record<string, string> = {
    'apps/demo/words.ts': `export const SHARED = ['批准'];
export const PATTERN = /^批准$/u;
`,
    'apps/demo/sites.ts': `import { PATTERN, SHARED } from './words.ts';
const WORDS = ['记住', '记下'] as const;
const PREFIX = '提醒';
export const literal = /(?:请)?记住/u;
export const escaped = /${BS}u8bb0${BS}u4f4f/;
export const singleInClass = /[年月]/;
export const joined = new RegExp(WORDS.join('|'), 'u');
export const template = new RegExp(\`^\${PREFIX}我\`);
export const sourced = RegExp(literal.source + '吧');
export const english = /^(?:please )?(?:do not|don't) remember/i;
export function keywords(text: string) {
  return (
    text.includes('不要') ||
    text.startsWith(PREFIX) ||
    WORDS.some((word) => text.includes(word)) ||
    ['确认', '好的'].includes(text) ||
    new Set(WORDS).has(text) ||
    WORDS.some((word) => new RegExp(word).test(text))
  );
}
class Gate {
  static WORDS = ['同意'];
}
export function shapes(text: string) {
  for (const word of WORDS) if (text.endsWith(word)) return 1;
  const TABLE = { 每天: 'daily', 每周: 'weekly' };
  if (Object.keys(TABLE).find((key) => text.includes(key))) return 2;
  if (Object.entries(TABLE).some(([key]) => text.startsWith(key))) return 3;
  const RULES = [{ words: ['删除', '移除'] }];
  if (RULES.find((rule) => rule.words.some((word) => text.includes(word)))) return 4;
  if (Gate.WORDS.some((word) => text.includes(word))) return 5;
  if (SHARED.some((word) => text.includes(word))) return 6;
  if (text in TABLE) return 7;
  if (TABLE[text as keyof typeof TABLE]) return 8;
  if (new Map([['确认', 1]]).get(text)) return 9;
  if (text === '确认' || text === 'please do not') return 10;
  switch (text) {
    case '好的':
      return 11;
  }
  const patterns = [1, 2].map((n) => '确认' + n);
  if (new RegExp(patterns.join('|')).test(text)) return 12;
  return PATTERN.test(text) || text.replace(literal, '') !== text;
}
`,
    'apps/demo/reexport.ts': `export { PATTERN as RENAMED } from './words.ts';
export * from './words.ts';
`,
    'apps/demo/barrel.ts': `import { PATTERN } from './words.ts';
import * as all from './words.ts';
export { PATTERN, all };
`,
    'apps/demo/round3.ts': `import { PATTERN, all } from './barrel.ts';
export function approve(text: string) {
  if (!/^(?:please do|go ahead)$/i.test(text)) return false;
  return PATTERN.test(text) || all.SHARED.includes(text);
}
export function page(text: string, spaced: boolean) {
  // r1-exempt(format): 只认“第 N 页”两种写法，不命中照常交给模型处理
  return (spaced ? /^第 [0-9]+ 页$/u : /^第[0-9]+页$/u).exec(text);
}
`,
    'apps/demo/round2.ts': `import * as words from './words.ts';
import { RENAMED, SHARED } from './reexport.ts';
export function copied(text: string) {
  const re = new RegExp(words.PATTERN, 'i');
  if (!re.test(text)) throw new Error('refused');
}
export function twice(text: string) {
  const p = /确认/u;
  if (!p.test(text)) throw new Error('refused');
  return text.replace(p, '');
}
export function reexported(text: string) {
  return RENAMED.test(text) || SHARED.includes(text);
}
export function bilingual(text: string, locale: string) {
  const re = new RegExp(locale === 'zh' ? '^确认$' : '^please confirm$');
  return re.test(text);
}
export function mapKeys(text: string) {
  const words = new Map([['同意', true]]);
  for (const word of words.keys()) if (text.includes(word)) return true;
  return [...words.keys()].some((word) => text.startsWith(word));
}
export function english(text: string, code: string) {
  return (
    /Please confirm/i.test(text) ||
    /DO NOT FORGET/i.test(text) ||
    code === 'STOP_NOT_CONFIRMED'
  );
}
export function inline(text: string) {
  return /^好的$/u.test(text);
}
const HOISTED = /^好的$/u;
export function hoisted(text: string) {
  return HOISTED.test(text);
}
// r1-exempt(format): 只认“好的”这一种写法，不命中照常交给模型处理
const MARKED = /^好的吧$/u;
export function marked(text: string) {
  return MARKED.test(text);
}
`,
    'apps/demo/scope.ts': `export function first(text: string) {
  const words = ['确认', '好的'];
  if (!words.some((w) => text.includes(w))) throw new Error('refused');
}
export function second(text: string) {
  const words = ['同意'];
  if (!words.some((w) => text.includes(w))) throw new Error('refused');
}
export function shadowed(label: string, text: string) {
  return text.includes(label);
}
export function other() {
  const label = '确认';
  return label;
}
`,
    'apps/demo/quiet.ts': `export const script = /[${BS}u4e00-${BS}u9fa5]+/u;
export const literalRange = /[一-龥]{2,}/u;
export const property = /${BS}p{Script=Han}{2,}/u;
export const punctuation = /[，。！？]/u;
export const oneWord = /${BS}bremember${BS}b/i;
export const actions = /^(?:create|update|delete)$/;
export function quiet(text: string, status: string) {
  return (
    text.split('、').length > 1 ||
    text.replace('提醒', '') !== text ||
    status === 'not found' ||
    status === 'ok'
  );
}
export const message = '请稍后重试';
`,
    'apps/demo/exempt.ts': `// r1-exempt(format): 只认“第 N 页”这一种写法，不命中照常交给模型
export const page = /第(${BS}d+)页/u;

export const inline = [/* r1-exempt(own-text): 系统自己写出的“资料依据”段落标记 */ /资料依据/u, /待核实/u];

export function header(text: string) {
  // r1-exempt(display): 只把开头的“提醒：”去掉再展示，不影响执行
  return text.replace(/^提醒：/u, '');
}

// r1-exempt(format): 一个标记管两处是不允许的，要分开写
export const two = [/年/u, /月/u];

// r1-exempt(format): 下面没有中文匹配，这条标记是多余的
export const none = /abc/;

// r1-exempt(whatever): 类别写错了也要报出来才行
export const unknown = /日/u;

// r1-exempt(format): 太短
export const short = /时/u;

export const trailing = /分/u; // r1-exempt(format): 写在行尾的标记不算数，要写在上面

// r1-exempt(display): 标在函数上，管不到函数体里的每一处
export function nested(text: string) {
  return /秒/u.test(text);
}

export const docs = 'r1-exempt(format) 写在字符串里不是标记';

// r1-exempt(constructor): 原型链上的名字不能当成例外类别
export const inherited = /周/u;

export function pick(text: string) {
  switch (text) {
    // r1-exempt(own-text): 系统提问卡给出的固定选项“先不创建”
    case '先不创建':
      return 0;
  }
  return 1;
}

export function branch(text: string) {
  if (text.length > 3) {
    return 1;
  } else if (/* r1-exempt(format): 只认“第 N 页”这种写法，不命中照常交给模型 */ /^第${BS}d+页$/u.test(text)) {
    return 2;
  }
  return 0;
}
`,
    'apps/demo/owners.ts': `export class Parser {
  field = /甲/u;
  parse(text: string) {
    const local = /乙/u;
    return local.test(text);
  }
}
export const table = { daily: /丙/u };
export const handler = (text: string) => {
  const inner = () => /丁/u.test(text);
  return inner();
};
`,
  };
  const of = (file: string) =>
    report.sites.filter((site) => site.file === `apps/demo/${file}`);
  const shown = (file: string) =>
    of(file).map((site) => `${site.owner} ${site.text}`);

  beforeAll(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'user-text-regex-')));
    await writeTree(project, files);
    report = scanUserTextMatches(project, Object.keys(files));
  });
  afterAll(async () => {
    if (project?.includes('user-text-regex-'))
      await rm(project, { recursive: true, force: true });
  });

  it('reports regexes, uses, keyword lists, tables and equality on wording', () => {
    // `literal` is applied by name in `shapes`: that application is its site.
    expect(shown('sites.ts')).toEqual([
      `escaped /${BS}u8bb0${BS}u4f4f/`,
      'singleInClass /[年月]/',
      'joined RegExp(/记住|记下/u)',
      'template RegExp(/^提醒我/)',
      'sourced RegExp(/(?:请)?记住吧/)',
      "english /^(?:please )?(?:do not|don't) remember/i",
      'keywords includes("不要")',
      'keywords startsWith("提醒")',
      'keywords some(includes(item)) over ["记住","记下"]',
      'keywords ["确认","好的"].includes()',
      'keywords ["记住","记下"].has()',
      'keywords some(RegExp(item)) over ["记住","记下"]',
      'shapes for-of(endsWith(item)) over ["记住","记下"]',
      'shapes find(includes(item)) over ["每天","每周"]',
      'shapes some(startsWith(item)) over ["每天","每周"]',
      'shapes some(includes(item)) over ["删除","移除"]',
      'shapes some(includes(item)) over ["同意"]',
      'shapes some(includes(item)) over ["批准"]',
      'shapes in ["每天","每周"]',
      'shapes [key] of ["每天","每周"]',
      'shapes ["确认"].get()',
      'shapes === "确认"',
      'shapes === "please do not"',
      'shapes case "好的"',
      'shapes RegExp(/确认${…}/)',
      'shapes test(/^批准$/u)',
      'shapes replace(/(?:请)?记住/u)',
    ]);
  });

  it('counts applications of a regex by name, through copies, namespaces and re-exports', () => {
    expect(shown('round2.ts')).toEqual([
      'copied test(/^批准$/u)',
      'twice test(/确认/u)',
      'twice replace(/确认/u)',
      'reexported test(/^批准$/u)',
      'reexported ["批准"].includes()',
      'bilingual test(RegExp(/${^确认$|^please confirm$}/))',
      'mapKeys for-of(includes(item)) over ["同意"]',
      'mapKeys some(startsWith(item)) over ["同意"]',
      'english /Please confirm/i',
      'english /DO NOT FORGET/i',
      'inline /^好的$/u',
      'hoisted test(/^好的$/u)',
      'marked test(/^好的吧$/u)',
    ]);
    // Moving a regex into a constant keeps one site in the same owner.
    expect(
      of('round2.ts').filter((site) => site.owner === 'inline'),
    ).toHaveLength(1);
    expect(
      of('round2.ts').filter((site) => site.owner === 'hoisted'),
    ).toHaveLength(1);
    expect(
      report.problems
        .filter((problem) => problem.file === 'apps/demo/round2.ts')
        .map((problem) => problem.problem.split(':')[0]),
    ).toEqual(['exemption on a regex that is applied by name']);
  });

  it('follows barrels that re-export imports, and exempts an application of a conditional regex', () => {
    expect(
      of('round3.ts').map((site) => [
        site.owner,
        site.text,
        site.exemption?.category ?? 'NEW',
      ]),
    ).toEqual([
      ['approve', '/^(?:please do|go ahead)$/i', 'NEW'],
      ['approve', 'test(/^批准$/u)', 'NEW'],
      ['approve', '["批准"].includes()', 'NEW'],
      [
        'page',
        'any(exec(item)) over ["/^第 [0-9]+ 页$/u","/^第[0-9]+页$/u"]',
        'format',
      ],
    ]);
    expect(
      report.problems.filter(
        (problem) => problem.file === 'apps/demo/round3.ts',
      ),
    ).toEqual([]);
  });

  it('resolves names by scope: same-named locals in other functions neither hide nor stand in', () => {
    expect(shown('scope.ts')).toEqual([
      'first some(includes(item)) over ["确认","好的"]',
      'second some(includes(item)) over ["同意"]',
    ]);
  });

  it('leaves script ranges, punctuation, single English words, tokens and plain strings alone', () => {
    expect(of('quiet.ts')).toEqual([]);
  });

  it('exempts one site per marker and reports misplaced or malformed markers', () => {
    expect(
      of('exempt.ts').map((site) => [
        site.text,
        site.exemption?.category ?? 'NEW',
      ]),
    ).toEqual([
      [`/第(${BS}d+)页/u`, 'format'],
      ['/资料依据/u', 'own-text'],
      ['/待核实/u', 'NEW'],
      ['/^提醒：/u', 'display'],
      ['/年/u', 'format'],
      ['/月/u', 'format'],
      ['/日/u', 'NEW'],
      ['/时/u', 'NEW'],
      ['/分/u', 'NEW'],
      ['/秒/u', 'NEW'],
      ['/周/u', 'NEW'],
      ['case "先不创建"', 'own-text'],
      [`/^第${BS}d+页$/u`, 'format'],
    ]);
    const problems = report.problems
      .filter((problem) => problem.file === 'apps/demo/exempt.ts')
      .map((problem) => [problem.line, problem.problem.split(/[:;(]/)[0]]);
    expect(problems).toEqual([
      [17, 'unknown exemption category `whatever`'],
      [
        20,
        'an exemption needs a reason of at least 10 characters on the marker line',
      ],
      [32, 'unknown exemption category `constructor`'],
      [11, 'one exemption covers 2 sites'],
      [14, 'exemption comment covers no site'],
      [23, 'exemption comment covers no site'],
      [25, 'exemption comment covers no site'],
      [30, 'r1-exempt marker the gate cannot attach to code'],
    ]);
  });

  it('names owners by function, class and module-level declaration, not locals', () => {
    expect(of('owners.ts').map((site) => site.owner)).toEqual([
      'Parser.field',
      'Parser.parse',
      'table.daily',
      'handler.inner',
    ]);
  });
});

describe('baseline bookkeeping', () => {
  const site = (file: string, owner: string, text: string) => ({
    file,
    line: 1,
    owner,
    kind: 'regex' as const,
    text,
  });
  const entry = (
    file: string,
    owner: string,
    sites: string[],
    kind: BaselineKind = 'reject',
  ): BaselineEntry => ({
    file,
    owner,
    kind,
    use: '没匹配上就拒绝创建任务',
    sites,
  });

  it('matches sites as a multiset by file, owner and text and checks entries', () => {
    const check = checkBaseline(
      {
        files: 1,
        problems: [],
        sites: [
          site('a.ts', 'f', '/记住/'),
          site('a.ts', 'f', '/记住/'),
          site('a.ts', 'g', '/记下/'),
          {
            ...site('a.ts', 'h', '/页/'),
            exemption: {
              category: 'format',
              reason: '只认一种页码写法，不拒绝',
              line: 1,
            },
          },
        ],
      },
      [
        entry('a.ts', 'f', ['/记住/']),
        entry('a.ts', 'g', ['/记下/', '/删除/']),
        { ...entry('b.ts', 'k', []), kind: 'constructor' as BaselineKind },
        { ...entry('b.ts', 'm', ['/x/']), use: '短' },
      ],
    );
    expect(check.added.map((s) => `${s.owner} ${s.text}`)).toEqual([
      'f /记住/',
    ]);
    expect(check.stale).toEqual([
      { file: 'a.ts', owner: 'g', text: '/删除/' },
      { file: 'b.ts', owner: 'm', text: '/x/' },
    ]);
    expect(check.problems.map((problem) => problem.problem)).toEqual([
      'entry 3 (b.ts k): unknown kind',
      'entry 3 (b.ts k): no sites',
      'entry 4 (b.ts m): `use` must say what the match decides',
    ]);
  });

  it('lets entries move or change in place and reports them for review', () => {
    const base = [entry('a.ts', 'f', ['/记住/', '/记下/'])];
    const change = baselineChange(
      [entry('a.ts', 'moved', ['/记住/']), entry('a.ts', 'f', ['/记下|记得/'])],
      base,
    );
    expect(change.growth).toEqual([]);
    expect(change.notices.map((notice) => notice.change).sort()).toEqual([
      'edited in place',
      'moved',
    ]);
    expect(
      baselineChange([entry('a.ts', 'f', ['/记住/'], 'format')], base),
    ).toMatchObject({
      growth: [],
      notices: [{ change: 'reclassified reject → format (leaves #2)' }],
    });
  });

  it('fails growth, including a change of kind or a move with a new owner and file', () => {
    const base = [entry('a.ts', 'f', ['/记住/', '/记下/'])];
    expect(
      baselineChange(
        [entry('a.ts', 'f', ['/记住/', '/记住/', '/记下/', '/新的/'])],
        base,
      ).growth,
    ).toHaveLength(2);
    expect(
      baselineChange([entry('b.ts', 'g', ['/记住/'])], base).growth,
    ).toHaveLength(1);
    // Reclassifying a not-R1 site into #2 says the code now refuses.
    expect(
      baselineChange(
        [entry('a.ts', 'f', ['/确认/'], 'reject')],
        [entry('a.ts', 'f', ['/确认/'], 'format')],
      ).growth,
    ).toHaveLength(1);
    // A reviewed not-R1 entry does not pay for a new #2 site.
    expect(
      baselineChange(
        [entry('a.ts', 'g', ['/确认/'], 'reject')],
        [entry('a.ts', 'f', ['/确认/'], 'format')],
      ).growth,
    ).toHaveLength(1);
  });

  it('does not depend on the order of entries with the same text', () => {
    const t = '/^(?:请)?(?:帮我|为我)\\s*/u';
    const once = entry('once.ts', 'taskClause', [t]);
    const recurring = entry('recurring.ts', 'normalizedTaskClause', [t]);
    // Recurring's copy moves to a helper in its file; once's copy is edited.
    const current = [
      entry('once.ts', 'taskClause', ['/^(?:请|麻烦你)?(?:帮我|为我)\\s*/u']),
      entry('recurring.ts', 'prefix', [t]),
    ];
    expect(baselineChange(current, [once, recurring]).growth).toEqual([]);
    expect(baselineChange(current, [recurring, once]).growth).toEqual([]);
  });

  it('reads only literal baselines', () => {
    expect(() =>
      parseBaseline(
        "const more = ['/x/'];\nexport const baseline = [{ file: 'a', owner: 'f', kind: 'reject', use: 'u', sites: more }];",
      ),
    ).toThrow(/`sites` must be an array literal/);
    expect(() =>
      parseBaseline(
        "const pattern = '/x/';\nexport const baseline = [{ file: 'a', owner: 'f', kind: 'reject', use: 'u', sites: [pattern] }];",
      ),
    ).toThrow(/expected a string literal/);
  });
});

describe('product files and the command line', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.email=gate@test', '-c', 'user.name=gate', ...args],
      { cwd: repo, stdio: 'pipe' },
    );
  const baselineFile = (sites: [string, string, string][]) =>
    `export const baseline = [\n${sites
      .map(
        ([file, owner, text]) =>
          `  { file: '${file}', owner: '${owner}', kind: 'reject', use: '没匹配上就拒绝创建任务', sites: [String.raw\`${text}\`] },`,
      )
      .join('\n')}\n];\n`;
  const run = (argv: string[], actions = false) => {
    const errors: string[] = [];
    const logs: string[] = [];
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation((line: string) => void errors.push(line));
    const log = vi
      .spyOn(console, 'log')
      .mockImplementation((line: string) => void logs.push(line));
    vi.stubEnv('GITHUB_ACTIONS', actions ? 'true' : '');
    try {
      return {
        code: runGate(repo, argv),
        output: errors.join('\n'),
        logs,
        annotations: logs.filter((line) => line.startsWith('::warning')),
      };
    } finally {
      error.mockRestore();
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  };

  beforeAll(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'user-text-regex-')));
    git('init', '-q');
    // A first commit from before the gate, then the gate's base.
    await writeTree(repo, { '.gitignore': 'apps/a/build/\n' });
    git('add', '-A');
    git('commit', '-q', '-m', 'before the gate');
    await writeTree(repo, {
      'apps/a/src/old.ts': 'export const old = /记住/u;\n',
      'apps/a/src/old.test.ts': 'export const t = /记住/u;\n',
      'apps/a/test/helper.ts': 'export const t = /记住/u;\n',
      'apps/a/src/fixtures/data.ts': 'export const t = /记住/u;\n',
      'apps/a/dist/out.js': 'export const t = /记住/u;\n',
      'apps/a/build/out.js': 'export const t = /记住/u;\n',
      'packages/p/src/data.fixture.ts': 'export const t = /记住/u;\n',
      'apps/web/app/api/methods/test/route.ts': 'export const n = 1;\n',
      'apps/web/app/chatflow/dsh-upstream/ui.ts': 'export const n = 1;\n',
      'scripts/tool.ts': 'export const t = /记住/u;\n',
      [BASELINE_PATH]: baselineFile([['apps/a/src/old.ts', 'old', '/记住/u']]),
    });
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
  });
  afterAll(async () => {
    if (repo?.includes('user-text-regex-'))
      await rm(repo, { recursive: true, force: true });
  });

  it('scans tracked and new product sources, never tests, fixtures or output', async () => {
    await writeTree(repo, { 'apps/a/src/new.ts': 'export const n = 1;\n' });
    expect(productFiles(repo)).toEqual([
      'apps/a/src/new.ts',
      'apps/a/src/old.ts',
      'apps/web/app/api/methods/test/route.ts',
      'apps/web/app/chatflow/dsh-upstream/ui.ts',
    ]);
  });

  it('rejects malformed arguments with exit code 2', () => {
    expect(run(['--base']).code).toBe(2);
    expect(run(['--base', '']).code).toBe(2);
    expect(run(['--base', '--list']).code).toBe(2);
    expect(run(['--base=HEAD']).code).toBe(2);
    expect(run(['--base', 'no-such-ref']).code).toBe(2);
  });

  it('passes on the base and fails on a new site, a stale entry and baseline growth', async () => {
    expect(run(['--base', 'HEAD'])).toMatchObject({ code: 0 });
    expect(run(['--base', 'HEAD~1']).output).toMatch(
      /base=[0-9a-f]{12} \(no baseline there yet; nothing to compare\)/,
    );

    await writeTree(repo, {
      'apps/a/src/new.ts': 'export const n = /记下/u;\n',
    });
    const added = run(['--base', 'HEAD', '--list']);
    expect(added.code).toBe(1);
    expect(added.logs).toEqual([
      'apps/a/src/new.ts:1\tn\tNEW\t/记下/u',
      'apps/a/src/old.ts:1\told\tbaseline:reject\t/记住/u',
    ]);
    expect(added.output).toContain('Wording matched outside the baseline');
    expect(added.output).toContain('apps/a/src/new.ts:1 n');

    // Listing the new site makes the baseline grow; the old one is now stale.
    await writeTree(repo, {
      'apps/a/src/old.ts': 'export const old = 1;\n',
      [BASELINE_PATH]: baselineFile([
        ['apps/a/src/old.ts', 'old', '/记住/u'],
        ['apps/a/src/new.ts', 'n', '/记下/u'],
      ]),
    });
    const grown = run(['--base', 'HEAD']);
    expect(grown.code).toBe(1);
    expect(grown.output).not.toContain('outside the baseline');
    expect(grown.output).toContain('Baseline sites no longer in the code');
    expect(grown.output).toMatch(
      /The baseline only shrinks; [0-9a-f]{40} held no matching site[^\n]*\n {2}apps\/a\/src\/new\.ts n \(reject\)/,
    );
  });

  it('lets a reasoned exemption through and puts it in front of review', async () => {
    await writeTree(repo, {
      'apps/a/src/old.ts': 'export const old = /记住/u;\n',
      'apps/a/src/new.ts':
        '// r1-exempt(format): 只认“第 N 页”这一种写法，不命中照常交给模型\nexport const n = /第(\\d+)页/u;\n',
      [BASELINE_PATH]: baselineFile([['apps/a/src/old.ts', 'old', '/记住/u']]),
    });
    const exempted = run(['--base', 'HEAD'], true);
    expect(exempted.code).toBe(0);
    expect(exempted.output).toContain(
      'Review under MET-220 R1 (allowed by the gate)',
    );
    expect(exempted.output).toContain(
      'apps/a/src/new.ts:1 new exemption: // r1-exempt(format)',
    );
    expect(exempted.annotations).toEqual([
      expect.stringMatching(
        /^::warning file=apps\/a\/src\/new\.ts,line=1,title=R1 review::new exemption: /,
      ),
    ]);
  });
});
