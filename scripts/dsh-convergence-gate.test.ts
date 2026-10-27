import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseline } from './dsh-convergence-gate.baseline.ts';
import {
  BASELINE_PATH,
  INITIAL_APPROVAL,
  KINDS,
  checkBaseline,
  parseBaseline,
  readStaticInventory,
  runGate,
  type BaselineEntry,
  type ItemKind,
} from './dsh-convergence-gate.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const approved = (kind: ItemKind = 'table'): BaselineEntry => ({
  kind,
  id: kind === 'table' ? 'allrice_native_test_x' : 'new-adapter',
  category: '门卫',
  basis: 'DSH 不维护 AllRice 租户的授权关系。',
  approvedBy: '2026-10-27 原话：“同意这个租户授权接缝。”',
});

describe('DSH convergence inventory and registration', () => {
  it('matches the real adaptation/private-interface inventory and parses the baseline as data', () => {
    expect(
      checkBaseline(readStaticInventory(root), baseline, baseline),
    ).toEqual([]);
    expect(
      parseBaseline(readFileSync(join(root, BASELINE_PATH), 'utf8')),
    ).toEqual(baseline);
  });

  it.each(KINDS)(
    'rejects an unregistered %s with registration instructions',
    (kind) => {
      const entry = approved(kind);
      expect(checkBaseline({ [kind]: [entry.id] }, [], [])).toEqual([
        expect.stringMatching(
          new RegExp(`${entry.id}.*新增未登记.*category.*basis.*approvedBy`),
        ),
      ]);
    },
  );

  it.each(KINDS)('requires removing a stale %s baseline row', (kind) => {
    const entry = approved(kind);
    expect(checkBaseline({ [kind]: [] }, [entry], [entry])).toEqual([
      expect.stringContaining(`${entry.id}: 实际已不存在`),
    ]);
    expect(checkBaseline({ [kind]: [] }, [], [entry])).toEqual([]);
  });

  it.each(KINDS)(
    'passes a newly approved %s and accepts a MET comment as approval evidence',
    (kind) => {
      const entry = approved(kind);
      expect(checkBaseline({ [kind]: [entry.id] }, [entry], [])).toEqual([]);
      entry.approvedBy =
        '2026-10-27 https://linear.app/met/issue/MET-210/example#comment-approval';
      expect(checkBaseline({ [kind]: [entry.id] }, [entry], [])).toEqual([]);
    },
  );

  it.each(['category', 'basis', 'approvedBy'] as const)(
    'rejects missing or blank %s on a new entry',
    (field) => {
      for (const value of [undefined, '', '  ']) {
        const entry = { ...approved(), [field]: value } as BaselineEntry;
        expect(checkBaseline({ table: [entry.id] }, [entry], [])).toEqual([
          expect.stringContaining(field),
        ]);
      }
    },
  );

  it('allows 待删 only for inherited initial entries, and rejects forged initial approval', () => {
    const initial: BaselineEntry = {
      ...approved(),
      category: '待删',
      approvedBy: INITIAL_APPROVAL,
    };
    expect(checkBaseline({ table: [initial.id] }, [initial], null)).toEqual([]);
    expect(
      checkBaseline({ table: [initial.id] }, [initial], [initial]),
    ).toEqual([]);
    expect(checkBaseline({ table: [initial.id] }, [initial], [])).toEqual([
      expect.stringContaining('category'),
      expect.stringContaining('approvedBy'),
    ]);
    expect(
      checkBaseline({}, [{ ...approved(), category: '待删' }], []),
    ).toEqual([expect.stringContaining('category')]);
    expect(checkBaseline({}, [initial], [approved()])).toHaveLength(2);
    expect(
      checkBaseline({}, [{ ...initial, kind: 'patch' }], [initial]),
    ).toHaveLength(2);
  });

  it('does not let deleted initial entries regain the initial exemption', () => {
    expect(
      checkBaseline({}, [{ ...approved(), approvedBy: INITIAL_APPROVAL }], []),
    ).toEqual([expect.stringContaining('approvedBy')]);
  });

  it('requires both the approval date and its source', () => {
    for (const approvedBy of [
      '2026-10-27',
      'approved',
      '2026-10-27 原话：',
      'https://linear.app/met/issue/MET-210#comment-a',
    ])
      expect(checkBaseline({}, [{ ...approved(), approvedBy }], [])).toEqual([
        expect.stringContaining('approvedBy'),
      ]);
  });

  it('rejects duplicate identities and invalid kinds', () => {
    expect(checkBaseline({}, [approved(), approved()], [])).toEqual([
      expect.stringContaining('重复登记'),
    ]);
    expect(
      checkBaseline(
        {},
        [{ ...approved(), kind: 'unknown' } as unknown as BaselineEntry],
        [],
      ),
    ).toEqual([expect.stringContaining('kind/id')]);
  });

  it('does not execute expressions in a baseline revision', () => {
    expect(() =>
      parseBaseline('export const baseline = [dangerous()];'),
    ).toThrow('对象字面量');
    expect(() =>
      parseBaseline('export const baseline = [{ id: process.env.SECRET }];'),
    ).toThrow('字符串字面量');
  });
});

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'dsh-convergence-')),
  );
  directories.push(directory);
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  };
  const inventory = (
    patches: string[],
    upstream = '@deepseek-ai/dsh-subagent/internal',
  ) => {
    write(
      'apps/worker/dsh/patch-ledger.json',
      JSON.stringify({ patches: patches.map((id) => ({ id })) }),
    );
    write(
      'apps/worker/dsh/compatibility.json',
      JSON.stringify({
        privateInterfaces: [{ id: 'host', upstreamInterface: upstream }],
      }),
    );
  };
  const register = (entries: readonly BaselineEntry[]) =>
    write(
      BASELINE_PATH,
      `export const baseline = [${entries
        .map(
          (entry) =>
            `{${Object.entries(entry)
              .map(([k, v]) => `${k}:${JSON.stringify(v)}`)
              .join(',')}}`,
        )
        .join(',')}];`,
    );
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Gate fixture');
  inventory([]);
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Before gate');
  const initial: BaselineEntry = {
    ...approved('private-interface'),
    id: 'host: @deepseek-ai/dsh-subagent/internal',
    category: '待删',
    approvedBy: INITIAL_APPROVAL,
  };
  register([initial]);
  return { directory, write, inventory, register, git, initial };
}

describe('CLI uses Git base and actual JSON files', () => {
  it('initializes once, blocks a new adaptation, requires approval, and enforces baseline deletion', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture();
    const run = () => runGate(f.directory, ['--base', 'HEAD']);
    expect(await run()).toBe(0);
    f.git('add', '.');
    f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Initial gate');
    const added = approved('patch');
    f.inventory([added.id]);
    expect(await run()).toBe(1);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining(`${added.id}: 新增未登记`),
    );
    f.register([f.initial, { ...added, approvedBy: INITIAL_APPROVAL }]);
    expect(await run()).toBe(1);
    f.register([f.initial, added]);
    expect(await run()).toBe(0);
    f.inventory([]);
    expect(await run()).toBe(1);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining(`${added.id}: 实际已不存在`),
    );
    f.register([f.initial]);
    expect(await run()).toBe(0);
  });

  it('detects a different private upstream interface even if the registry id stays the same', () => {
    const f = fixture();
    f.inventory([], '@deepseek-ai/dsh-other/internal');
    const errors = checkBaseline(
      readStaticInventory(f.directory),
      [f.initial],
      [f.initial],
    );
    expect(errors).toEqual([
      expect.stringContaining('@deepseek-ai/dsh-other/internal: 新增未登记'),
      expect.stringContaining(
        '@deepseek-ai/dsh-subagent/internal: 实际已不存在',
      ),
    ]);
  });

  it('fails closed for a malformed registry, bad base or unsupported flags', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture();
    f.write('apps/worker/dsh/compatibility.json', '{}');
    expect(await runGate(f.directory, ['--base', 'HEAD'])).toBe(2);
    expect(await runGate(f.directory, ['--base', 'missing-ref'])).toBe(2);
    expect(await runGate(f.directory, ['--base'])).toBe(2);
    expect(await runGate(f.directory, ['--unknown'])).toBe(2);
  });
});
