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
  baselineGrowth,
  checkBaseline,
  parseBaseline,
  productFiles,
  runGate,
  scanUserTextMatches,
  type BaselineEntry,
  type ScanReport,
} from './user-text-regex-gate.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
// Written out so no escape in these fixtures is decoded before the scan sees it.
const BS = String.fromCharCode(92);

/**
 * MET-210 #2 gate (MET-220 R1): product code may not add a regex or keyword
 * match on Chinese wording outside the baseline, and the baseline lists only
 * what is still in the code.
 */
describe('Chinese wording matches stay within the baseline', () => {
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
    'apps/demo/sites.ts': `const WORDS = ['记住', '记下'] as const;
const PREFIX = '提醒';
export const literal = /(?:请)?记住/u;
export const escaped = /${BS}u8bb0${BS}u4f4f/;
export const singleInClass = /[年月]/;
export const joined = new RegExp(WORDS.join('|'), 'u');
export const template = new RegExp(\`^\${PREFIX}我\`);
export const sourced = RegExp(literal.source + '吧');
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
`,
    'apps/demo/quiet.ts': `export const script = /[${BS}u4e00-${BS}u9fa5]+/u;
export const literalRange = /[一-龥]{2,}/u;
export const property = /${BS}p{Script=Han}{2,}/u;
export const punctuation = /[，。！？]/u;
export const english = /${BS}bremember${BS}b/i;
export function quiet(text: string) {
  return text === '确认' || text.split('、').length > 1 || text.replace('提醒', '') !== text;
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

  beforeAll(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'user-text-regex-')));
    await writeTree(project, files);
    report = scanUserTextMatches(project, Object.keys(files));
  });
  afterAll(async () => {
    if (project?.includes('user-text-regex-'))
      await rm(project, { recursive: true, force: true });
  });

  it('reports regexes and keyword matches on Chinese wording', () => {
    expect(of('sites.ts').map((site) => [site.owner, site.text])).toEqual([
      ['literal', '/(?:请)?记住/u'],
      ['escaped', `/${BS}u8bb0${BS}u4f4f/`],
      ['singleInClass', '/[年月]/'],
      ['joined', 'RegExp(/记住|记下/u)'],
      ['template', 'RegExp(/^提醒我/)'],
      ['sourced', 'RegExp(/(?:请)?记住吧/)'],
      ['keywords', 'includes("不要")'],
      ['keywords', 'startsWith("提醒")'],
      ['keywords', 'some(includes(item)) over ["记住","记下"]'],
      ['keywords', '["确认","好的"].includes()'],
      ['keywords', '["记住","记下"].has()'],
      ['keywords', 'some(RegExp(item)) over ["记住","记下"]'],
    ]);
  });

  it('leaves script ranges, punctuation, English, equality and plain strings alone', () => {
    expect(of('quiet.ts')).toEqual([]);
  });

  it('exempts one site per marker and reports misplaced or malformed markers', () => {
    expect(
      of('exempt.ts').map((site) => [
        site.text,
        site.exemption?.category ?? 'NEW',
      ]),
    ).toEqual([
      ['/第(\\d+)页/u', 'format'],
      ['/资料依据/u', 'own-text'],
      ['/待核实/u', 'NEW'],
      ['/^提醒：/u', 'display'],
      ['/年/u', 'format'],
      ['/月/u', 'format'],
      ['/日/u', 'NEW'],
      ['/时/u', 'NEW'],
      ['/分/u', 'NEW'],
      ['/秒/u', 'NEW'],
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
      [11, 'one exemption covers 2 sites'],
      [14, 'exemption comment covers no site'],
      [23, 'exemption comment covers no site'],
      [25, 'exemption comment covers no site'],
      [30, 'r1-exempt marker outside a comment the gate reads'],
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
  ): BaselineEntry => ({
    file,
    owner,
    kind: 'reject',
    use: '没匹配上就拒绝创建任务',
    sites,
  });

  it('matches sites as a multiset by file, owner and text', () => {
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
      ],
    );
    expect(check.added.map((s) => `${s.owner} ${s.text}`)).toEqual([
      'f /记住/',
    ]);
    expect(check.stale).toEqual([{ file: 'a.ts', owner: 'g', text: '/删除/' }]);
  });

  it('lets entries move or change in place but never grow against the base', () => {
    const base = [entry('a.ts', 'f', ['/记住/', '/记下/'])];
    // Moved to another owner; edited in place within the same owner.
    expect(
      baselineGrowth(
        [
          entry('b.ts', 'moved', ['/记住/']),
          entry('a.ts', 'f', ['/记下|记得/']),
        ],
        base,
      ),
    ).toEqual([]);
    expect(
      baselineGrowth(
        [entry('a.ts', 'f', ['/记住/', '/记住/', '/记下/', '/新的/'])],
        base,
      ),
    ).toEqual([
      { file: 'a.ts', owner: 'f', text: '/记住/' },
      { file: 'a.ts', owner: 'f', text: '/新的/' },
    ]);
    // A changed text in another owner is not an edit in place.
    expect(baselineGrowth([entry('a.ts', 'g', ['/记住|记下/'])], base)).toEqual(
      [{ file: 'a.ts', owner: 'g', text: '/记住|记下/' }],
    );
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
  const run = (argv: string[]) => {
    const lines: string[] = [];
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation((line: string) => void lines.push(line));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      return { code: runGate(repo, argv), output: lines.join('\n') };
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  };

  beforeAll(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'user-text-regex-')));
    git('init', '-q');
    await writeTree(repo, {
      '.gitignore': 'apps/a/build/\n',
      'apps/a/src/old.ts': 'export const old = /记住/u;\n',
      'apps/a/src/old.test.ts': 'export const t = /记住/u;\n',
      'apps/a/test/helper.ts': 'export const t = /记住/u;\n',
      'apps/a/dist/out.js': 'export const t = /记住/u;\n',
      'apps/a/build/out.js': 'export const t = /记住/u;\n',
      'packages/p/src/data.fixture.ts': 'export const t = /记住/u;\n',
      'apps/web/app/chatflow/dsh-upstream/ui.ts': 'export const t = /记住/u;\n',
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

  it('scans tracked and new product sources, never tests, fixtures, output or the DSH UI copy', async () => {
    await writeTree(repo, { 'apps/a/src/new.ts': 'export const n = 1;\n' });
    expect(productFiles(repo)).toEqual([
      'apps/a/src/new.ts',
      'apps/a/src/old.ts',
    ]);
  });

  it('passes on the base and fails on a new site, a stale entry and baseline growth', async () => {
    expect(run(['--base', 'HEAD'])).toMatchObject({ code: 0 });

    await writeTree(repo, {
      'apps/a/src/new.ts': 'export const n = /记下/u;\n',
    });
    const added = run(['--base', 'HEAD']);
    expect(added.code).toBe(1);
    expect(added.output).toContain(
      'Chinese wording matched outside the baseline',
    );
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
      /The baseline only shrinks; [0-9a-f]{40} did not hold:\n {2}apps\/a\/src\/new\.ts n/,
    );

    expect(run(['--base', 'no-such-ref']).code).toBe(2);
  });
});
