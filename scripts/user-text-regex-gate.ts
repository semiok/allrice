/**
 * Gate on matching the user's wording with regexes (MET-210 #2, MET-220 R1).
 *
 * R1: understanding the user is the model's job, and authorization comes from
 * the request's source and a confirmation card. A regex may let one clear
 * format through; matching the user's words and refusing, failing or skipping
 * when they do not match is what this gate keeps from growing back.
 *
 * Whether a pattern runs on the user's words, and whether a miss refuses,
 * cannot be decided statically, so `scanUserTextMatches` over-approximates. It
 * reports every place in product code (apps/ and packages/; tests, fixtures
 * and the pinned DSH UI copy excluded) that matches Chinese wording:
 *
 * - a regex literal whose pattern holds a Han character (escapes decoded;
 *   character-class ranges such as `[\u4e00-\u9fa5]` name a script, not
 *   wording, and are skipped);
 * - `RegExp(...)` / `new RegExp(...)` whose pattern resolves to such text
 *   through same-file constants, templates, `+`, `.join()`, `.map()` or
 *   `.source`;
 * - a string match (`includes`, `startsWith`, `endsWith`, `indexOf`,
 *   `lastIndexOf`, `match`, `matchAll`, `search`) whose needle resolves to
 *   Han text, the same match on the item of a Han keyword list
 *   (`WORDS.some((word) => text.includes(word))`), and membership in such a
 *   list (`WORDS.includes(text)`, `new Set(WORDS).has(text)`).
 *
 * Each site must be in the baseline (`user-text-regex-gate.baseline.ts`: the
 * sites that predate the gate, removed as #2 migrates them) or carry its own
 * exemption: the nearest leading comment of the site, or of the statement,
 * property or class member holding it, reads
 *
 *   // r1-exempt(<category>): <reason, on the marker line>
 *
 * with a category from `EXEMPTIONS` (format, own-text, external-text,
 * display). One exemption covers one site. Not covered: equality
 * (`text === '确认'`), patterns or keyword lists built in another file,
 * English-only wording, and non-JavaScript sources.
 *
 *   node --import tsx scripts/user-text-regex-gate.ts [--base <git ref>] [--list] [--json]
 *
 * `--base` (default: the merge base with origin/main) also fails when the
 * baseline holds a site the base commit's baseline did not: the list only
 * shrinks. Entries may move between files and owners with their code.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export const BASELINE_PATH = 'scripts/user-text-regex-gate.baseline.ts';

/** What an exemption comment may claim. Anything else is a #2 decision. */
export const EXEMPTIONS = {
  format:
    '只认一种明确写法（日期、编号、固定口令等）：命中就放行或取值，不命中照常交给模型或走默认流程，不拒绝、不报错、不跳过',
  'own-text':
    '匹配的是本系统自己写出的固定文本或标记（含提问卡上系统给的选项），不是用户原话，也不是模型输出',
  'external-text':
    '匹配的是外部系统写出的固定文案（网页拦截页、第三方报错），不是用户原话；外部给了错误码就用错误码',
  display: '只影响展示（高亮、截断、排版），不影响做不做、怎么做',
} as const;
export type ExemptionCategory = keyof typeof EXEMPTIONS;

/** How a baseline site uses the wording: the first three are #2 work. */
export const BASELINE_KINDS = {
  reject: '没匹配上就拒绝、报错或不执行（R1 本身）',
  decide:
    '据此决定怎么做：走哪条路、默认值、算不算证据、错误归哪类；猜错了用户拿不到想要的结果',
  extract: '从原话里取值（时间、名称、内容），取错或取不到会改变执行结果',
  ...EXEMPTIONS,
} as const;
export type BaselineKind = keyof typeof BASELINE_KINDS;

export type BaselineEntry = {
  file: string;
  /** Dotted names of the declarations holding the sites. */
  owner: string;
  kind: BaselineKind;
  /** 用途: what the match decides, in a sentence a reviewer can check. */
  use: string;
  /** Site texts as `--list` prints them. */
  sites: readonly string[];
};

export type Exemption = {
  category: ExemptionCategory;
  reason: string;
  line: number;
};

export type Site = {
  /** Repository-relative path. */
  file: string;
  line: number;
  /** Dotted names of the declarations holding the site (`<module>` at top level). */
  owner: string;
  kind: 'regex' | 'keyword';
  /** Identity in the baseline: the regex as written, or the resolved pattern or needle. */
  text: string;
  exemption?: Exemption;
};

export type Problem = { file: string; line: number; problem: string };

export type ScanReport = { files: number; sites: Site[]; problems: Problem[] };

const HAN = /\p{Script=Han}/u;
const MARKER = /r1-exempt\(([^)]*)\)\s*[:：]?\s*(.*)/;
const MIN_REASON = 10;
const STRING_MATCH = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'lastIndexOf',
  'match',
  'matchAll',
  'search',
]);
const MEMBERSHIP = new Set(['includes', 'indexOf', 'lastIndexOf', 'has']);
const ITERATION = new Set([
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'filter',
  'map',
  'flatMap',
  'forEach',
]);
/** Sources that are not AllRice product code. */
const SKIPPED =
  /(?:^|\/)(?:node_modules|dist|coverage|test|tests|__tests__|fixtures?)\/|\.(?:test|spec|fixture)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$|^apps\/web\/app\/chatflow\/dsh-upstream\//;
const SOURCE = /\.[cm]?[jt]sx?$/;

/** Product sources under apps/ and packages/: tracked or new, not ignored. */
export function productFiles(root: string) {
  return execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      'apps',
      'packages',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter(
      (path) =>
        SOURCE.test(path) &&
        !SKIPPED.test(path) &&
        existsSync(join(root, path)),
    )
    .sort();
}

/**
 * Whether a regex source names Han wording. Escapes are decoded; both ends of
 * a character-class range are skipped, and so is `\p{...}`.
 */
export function patternHasHan(source: string) {
  type Atom = { char: string; dash: boolean };
  const classes: Atom[][] = [];
  let current: Atom[] | null = null;
  for (let index = 0; index < source.length;) {
    let char = String.fromCodePoint(source.codePointAt(index)!);
    let step = char.length;
    let dash = false;
    if (char === '\\') {
      const escape =
        /^(?:u\{([0-9a-f]+)\}|u([0-9a-f]{4})|x([0-9a-f]{2})|[pP]\{[^}]*\}|[^])/iu.exec(
          source.slice(index + 1),
        );
      if (!escape) break;
      const hex = escape[1] ?? escape[2] ?? escape[3];
      char = hex
        ? String.fromCodePoint(parseInt(hex, 16))
        : /^[pP]\{/.test(escape[0])
          ? ''
          : escape[0];
      step = 1 + escape[0].length;
    } else if (!current && char === '[') {
      current = [];
      index += 1;
      continue;
    } else if (current && char === ']') {
      classes.push(current);
      current = null;
      index += 1;
      continue;
    } else if (current && char === '-') dash = true;
    if (current) current.push({ char, dash });
    else if (HAN.test(char)) return true;
    index += step;
  }
  if (current) classes.push(current);
  return classes.some((atoms) =>
    atoms.some((atom, at) => {
      if (atom.dash || !HAN.test(atom.char)) return false;
      const startsRange = atoms[at + 1]?.dash && atoms[at + 2];
      const endsRange = atoms[at - 1]?.dash && atoms[at - 2];
      return !startsRange && !endsRange;
    }),
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  )
    node = node.expression;
  return node;
}

function nameText(name: ts.Node | undefined) {
  if (!name) return '';
  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  )
    return name.text;
  return '';
}

const functionLike = (node: ts.Node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isAccessor(node) ||
  ts.isConstructorDeclaration(node);

/**
 * The owner names functions, classes and module-level data, not the locals
 * inside a function, so renaming a local does not move a baseline entry.
 */
function declarationName(node: ts.Node) {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isAccessor(node)
  )
    return nameText(node.name);
  if (
    ts.isPropertyDeclaration(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isVariableDeclaration(node)
  ) {
    const value = node.initializer && unwrap(node.initializer);
    const holdsCode =
      value &&
      (ts.isArrowFunction(value) ||
        ts.isFunctionExpression(value) ||
        ts.isClassExpression(value));
    let local = false;
    for (let cursor: ts.Node = node.parent; cursor && !local;) {
      local = functionLike(cursor);
      cursor = cursor.parent;
    }
    return holdsCode || !local ? nameText(node.name) : '';
  }
  return '';
}

/** Statements, class members and object properties own their leading comment. */
function holdsComments(node: ts.Node) {
  return (
    ts.isStatement(node) ||
    ts.isClassElement(node) ||
    ts.isObjectLiteralElementLike(node)
  );
}

function scanFile(path: string, text: string) {
  const kind = /x$/.test(path) ? ts.ScriptKind.TSX : undefined;
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const lineOf = (position: number) =>
    file.getLineAndCharacterOfPosition(position).line + 1;

  // Same-file `const` initializers by name; a name declared twice is unknown.
  const constants = new Map<string, ts.Expression[]>();
  const collect = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const
    )
      constants.set(node.name.text, [
        ...(constants.get(node.name.text) ?? []),
        node.initializer,
      ]);
    ts.forEachChild(node, collect);
  };
  collect(file);
  const constant = (node: ts.Identifier) => {
    const found = constants.get(node.text);
    return found?.length === 1 ? found[0] : undefined;
  };

  function regexBody(node: ts.Expression, depth = 0): string | undefined {
    node = unwrap(node);
    if (ts.isRegularExpressionLiteral(node))
      return node.text.slice(1, node.text.lastIndexOf('/'));
    if (ts.isIdentifier(node) && depth < 8) {
      const value = constant(node);
      return value && regexBody(value, depth + 1);
    }
    return undefined;
  }

  /** Unknown parts read `${…}`; Han text in the known parts still counts. */
  function templateText(node: ts.TemplateLiteral, raw: boolean, depth: number) {
    const part = (literal: ts.TemplateLiteralLikeNode) =>
      raw ? (literal.rawText ?? literal.text) : literal.text;
    if (ts.isNoSubstitutionTemplateLiteral(node)) return part(node);
    return node.templateSpans.reduce(
      (text, span) =>
        text +
        (stringOf(span.expression, depth + 1) ?? '${…}') +
        part(span.literal),
      part(node.head),
    );
  }

  function stringOf(node: ts.Expression, depth = 0): string | undefined {
    if (depth > 8) return undefined;
    node = unwrap(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text;
    if (ts.isTemplateExpression(node)) return templateText(node, false, depth);
    if (
      ts.isTaggedTemplateExpression(node) &&
      node.tag.getText(file) === 'String.raw'
    )
      return templateText(node.template, true, depth);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = stringOf(node.left, depth + 1);
      const right = stringOf(node.right, depth + 1);
      return left === undefined && right === undefined
        ? undefined
        : (left ?? '${…}') + (right ?? '${…}');
    }
    if (ts.isIdentifier(node)) {
      const value = constant(node);
      return value && stringOf(value, depth + 1);
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'source')
      return regexBody(node.expression, depth + 1);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'join'
    ) {
      const items = listOf(node.expression.expression, depth + 1);
      const separator = node.arguments[0]
        ? (stringOf(node.arguments[0], depth + 1) ?? '${…}')
        : ',';
      return items?.join(separator);
    }
    return undefined;
  }

  /** Known string items of a list; `.map()` and the like keep their source items. */
  function listOf(node: ts.Expression, depth = 0): string[] | undefined {
    if (depth > 8) return undefined;
    node = unwrap(node);
    if (ts.isArrayLiteralExpression(node))
      return node.elements.flatMap((element) =>
        ts.isSpreadElement(element)
          ? (listOf(element.expression, depth + 1) ?? [])
          : (stringOf(element, depth + 1) ?? []),
      );
    if (ts.isIdentifier(node)) {
      const value = constant(node);
      return value && listOf(value, depth + 1);
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Set' &&
      node.arguments?.[0]
    )
      return listOf(node.arguments[0], depth + 1);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['map', 'filter', 'slice', 'concat', 'flat'].includes(
        node.expression.name.text,
      )
    ) {
      const base = listOf(node.expression.expression, depth + 1);
      if (!base) return undefined;
      return node.expression.name.text === 'concat'
        ? [
            ...base,
            ...node.arguments.flatMap(
              (argument) => listOf(argument, depth + 1) ?? [],
            ),
          ]
        : base;
    }
    return undefined;
  }

  const hanList = (list: string[] | undefined) =>
    list?.some((item) => HAN.test(item)) ? list : undefined;

  /** A callback parameter iterating a Han keyword list, and that list. */
  function keywordItem(node: ts.Expression) {
    node = unwrap(node);
    if (!ts.isIdentifier(node)) return undefined;
    for (let cursor = node.parent; cursor; cursor = cursor.parent) {
      if (!ts.isArrowFunction(cursor) && !ts.isFunctionExpression(cursor))
        continue;
      const parameter = cursor.parameters.findIndex(
        (entry) => nameText(entry.name) === node.text,
      );
      if (parameter < 0) continue;
      const call = cursor.parent;
      if (
        parameter !== 0 ||
        !ts.isCallExpression(call) ||
        call.arguments[0] !== cursor ||
        !ts.isPropertyAccessExpression(call.expression) ||
        !ITERATION.has(call.expression.name.text)
      )
        return undefined;
      const list = hanList(listOf(call.expression.expression));
      return list && { iteration: call.expression.name.text, list };
    }
    return undefined;
  }

  const sites: Site[] = [];
  const nodes = new Map<Site, ts.Node>();
  const add = (node: ts.Node, kind: Site['kind'], siteText: string) => {
    const names: string[] = [];
    for (let cursor = node.parent; cursor && !ts.isSourceFile(cursor);) {
      const name = declarationName(cursor);
      if (name) names.unshift(name);
      cursor = cursor.parent;
    }
    const site: Site = {
      file: path,
      line: lineOf(node.getStart(file)),
      owner: names.join('.') || '<module>',
      kind,
      text: siteText,
    };
    sites.push(site);
    nodes.set(site, node);
  };
  const json = (value: unknown) => JSON.stringify(value);

  const visit = (node: ts.Node) => {
    if (ts.isRegularExpressionLiteral(node)) {
      if (patternHasHan(regexBody(node) ?? '')) add(node, 'regex', node.text);
    } else if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'RegExp' &&
      node.arguments?.[0] &&
      // Copying a regex: the literal is the site.
      regexBody(node.arguments[0]) === undefined
    ) {
      const pattern = stringOf(node.arguments[0]);
      const flags = node.arguments[1] && stringOf(node.arguments[1]);
      const item = keywordItem(node.arguments[0]);
      if (pattern !== undefined && patternHasHan(pattern))
        add(node, 'regex', `RegExp(/${pattern}/${flags ?? ''})`);
      else if (item)
        add(
          node,
          'regex',
          `${item.iteration}(RegExp(item)) over ${json(item.list)}`,
        );
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      const needle = node.arguments[0];
      const list = MEMBERSHIP.has(method)
        ? hanList(listOf(node.expression.expression))
        : undefined;
      if (list) add(node, 'keyword', `${json(list)}.${method}()`);
      else if (
        STRING_MATCH.has(method) &&
        needle &&
        regexBody(needle) === undefined
      ) {
        const value = stringOf(needle);
        const item = keywordItem(needle);
        if (value !== undefined && HAN.test(value))
          add(node, 'keyword', `${method}(${json(value)})`);
        else if (item)
          add(
            node,
            'keyword',
            `${item.iteration}(${method}(item)) over ${json(item.list)}`,
          );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  // Exemption comments: every marker in the file, then the one nearest each site.
  const problems: Problem[] = [];
  type Marker = {
    line: number;
    end: number;
    exemption?: Exemption;
    covers: number;
  };
  const markers = new Map<number, Marker>();
  const parseMarker = (range: ts.CommentRange) => {
    const match = MARKER.exec(text.slice(range.pos, range.end));
    if (!match) return undefined;
    const at = range.pos + match.index;
    if (markers.has(at)) return at;
    const line = lineOf(at);
    const category = match[1]!.trim();
    const reason = match[2]!.replace(/\*\/\s*$/, '').trim();
    const marker: Marker = { line, end: range.end, covers: 0 };
    if (!(category in EXEMPTIONS))
      problems.push({
        file: path,
        line,
        problem: `unknown exemption category \`${category}\`; use one of ${Object.keys(EXEMPTIONS).join(', ')}`,
      });
    else if ([...reason].length < MIN_REASON)
      problems.push({
        file: path,
        line,
        problem: `an exemption needs a reason of at least ${MIN_REASON} characters on the marker line: why a miss refuses nothing`,
      });
    else
      marker.exemption = {
        category: category as ExemptionCategory,
        reason,
        line,
      };
    markers.set(at, marker);
    return at;
  };
  // Leading comments start after a line break, so a comment trailing the
  // previous line never exempts the next statement. A block comment on the
  // site's own line, right before it, exempts that site alone.
  const leading = (node: ts.Node) =>
    ts.getLeadingCommentRanges(text, node.pos) ?? [];
  const inline = (node: ts.Node) =>
    (ts.getTrailingCommentRanges(text, node.pos) ?? []).filter(
      (range) =>
        range.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
        lineOf(range.end) === lineOf(node.getStart(file)),
    );
  const register = (node: ts.Node) => {
    for (const range of leading(node)) parseMarker(range);
    for (const range of ts.getTrailingCommentRanges(text, node.end) ?? [])
      parseMarker(range);
    ts.forEachChild(node, register);
  };
  register(file);

  for (const site of sites) {
    const node = nodes.get(site)!;
    let found: number | undefined;
    for (
      let cursor: ts.Node | undefined = node;
      cursor && !ts.isSourceFile(cursor) && found === undefined;
      cursor = cursor.parent
    ) {
      const ranges =
        cursor === node
          ? [...leading(cursor), ...inline(cursor)]
          : leading(cursor);
      for (const range of ranges) found = parseMarker(range) ?? found;
      if (holdsComments(cursor)) break;
    }
    if (found === undefined) continue;
    const marker = markers.get(found)!;
    marker.covers += 1;
    if (marker.exemption) site.exemption = marker.exemption;
  }
  for (const marker of markers.values()) {
    if (marker.covers === 0)
      problems.push({
        file: path,
        line: marker.line,
        problem:
          'exemption comment covers no site: put it directly above the regex or keyword match it exempts (or inline as /* ... */ right before it), or delete it',
      });
    else if (marker.covers > 1)
      problems.push({
        file: path,
        line: marker.line,
        problem: `one exemption covers ${marker.covers} sites; give each site its own comment (/* r1-exempt(...): ... */ works inline)`,
      });
  }
  // A marker the walk above cannot see (inside JSX, or in a string) is not
  // silently ignored.
  for (const found of text.matchAll(/r1-exempt\(/g))
    if (
      ![...markers].some(
        ([at, marker]) => found.index >= at && found.index < marker.end,
      )
    )
      problems.push({
        file: path,
        line: lineOf(found.index),
        problem:
          'r1-exempt marker outside a comment the gate reads: put it in a // or /* */ comment directly above the site',
      });
  return { sites, problems };
}

/** Every site in `files` (repository-relative), sorted by file and line. */
export function scanUserTextMatches(
  root: string,
  files: readonly string[] = productFiles(root),
): ScanReport {
  const sites: Site[] = [];
  const problems: Problem[] = [];
  for (const path of files) {
    const text = readFileSync(join(root, path), 'utf8');
    if (
      !HAN.test(text) &&
      !text.includes('\\u') &&
      !text.includes('\\x') &&
      !text.includes('r1-exempt')
    )
      continue;
    const result = scanFile(path, text);
    sites.push(...result.sites);
    problems.push(...result.problems);
  }
  return { files: files.length, sites, problems };
}

const key = (file: string, owner: string, text: string) =>
  `${file}\0${owner}\0${text}`;

export type BaselineCheck = {
  /** Sites neither in the baseline nor exempted. */
  added: Site[];
  /** Baseline sites no longer in the code. */
  stale: { file: string; owner: string; text: string }[];
  /** Malformed baseline entries and exemption comments. */
  problems: Problem[];
};

export function checkBaseline(
  report: ScanReport,
  baseline: readonly BaselineEntry[],
): BaselineCheck {
  const problems = [...report.problems];
  const remaining = new Map<string, number>();
  baseline.forEach((entry, index) => {
    const where = { file: BASELINE_PATH, line: index + 1 };
    if (!(entry.kind in BASELINE_KINDS))
      problems.push({ ...where, problem: `entry ${index + 1}: unknown kind` });
    if ([...entry.use.trim()].length < MIN_REASON)
      problems.push({
        ...where,
        problem: `entry ${index + 1}: \`use\` must say what the match decides`,
      });
    if (!entry.sites.length)
      problems.push({ ...where, problem: `entry ${index + 1}: no sites` });
    for (const text of entry.sites) {
      const id = key(entry.file, entry.owner, text);
      remaining.set(id, (remaining.get(id) ?? 0) + 1);
    }
  });
  const added: Site[] = [];
  for (const site of report.sites) {
    if (site.exemption) continue;
    const id = key(site.file, site.owner, site.text);
    const left = remaining.get(id) ?? 0;
    if (left > 0) remaining.set(id, left - 1);
    else added.push(site);
  }
  const stale = [...remaining].flatMap(([id, count]) => {
    const [file, owner, text] = id.split('\0') as [string, string, string];
    return Array.from({ length: count }, () => ({ file, owner, text }));
  });
  return { added, stale, problems };
}

type Listed = { file: string; owner: string; text: string };

/** The sites of `entries` that `other` does not hold, by text, as a multiset. */
function unmatched(
  entries: readonly BaselineEntry[],
  other: readonly BaselineEntry[],
) {
  const left = new Map<string, number>();
  for (const entry of other)
    for (const text of entry.sites) left.set(text, (left.get(text) ?? 0) + 1);
  return entries.flatMap((entry) =>
    entry.sites.flatMap((text): Listed[] => {
      const count = left.get(text) ?? 0;
      if (count > 0) {
        left.set(text, count - 1);
        return [];
      }
      return [{ file: entry.file, owner: entry.owner, text }];
    }),
  );
}

/**
 * Baseline sites the base baseline did not hold. Texts are counted across the
 * whole list, so an entry may follow its code to another file or owner. A
 * changed text counts as an edit in place when the same file and owner lost
 * one; otherwise it is growth. No owner's count can grow either way.
 */
export function baselineGrowth(
  current: readonly BaselineEntry[],
  base: readonly BaselineEntry[],
) {
  const replaced = new Map<string, number>();
  for (const site of unmatched(base, current)) {
    const id = `${site.file}\0${site.owner}`;
    replaced.set(id, (replaced.get(id) ?? 0) + 1);
  }
  return unmatched(current, base).filter((site) => {
    const id = `${site.file}\0${site.owner}`;
    const count = replaced.get(id) ?? 0;
    if (count > 0) replaced.set(id, count - 1);
    return count === 0;
  });
}

/**
 * Reads a baseline file without running it (the base commit's copy is data):
 * `export const baseline = [{ file, owner, kind, use, sites: [...] }]` with
 * string literals or `String.raw` templates.
 */
export function parseBaseline(source: string): BaselineEntry[] {
  const file = ts.createSourceFile(
    BASELINE_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const fail = (node: ts.Node, message: string): never => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    throw new Error(`${BASELINE_PATH}:${line + 1}: ${message}`);
  };
  const literal = (node: ts.Expression): string => {
    node = unwrap(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text;
    if (
      ts.isTaggedTemplateExpression(node) &&
      node.tag.getText(file) === 'String.raw' &&
      ts.isNoSubstitutionTemplateLiteral(node.template)
    )
      return node.template.rawText ?? node.template.text;
    return fail(node, 'expected a string literal');
  };
  let found: BaselineEntry[] | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      nameText(node.name) === 'baseline' &&
      node.initializer
    ) {
      const array = unwrap(node.initializer);
      if (!ts.isArrayLiteralExpression(array))
        fail(node, '`baseline` must be an array literal');
      found = (array as ts.ArrayLiteralExpression).elements.map((element) => {
        if (!ts.isObjectLiteralExpression(element))
          return fail(element, 'expected an object literal');
        const fields = new Map<string, ts.Expression>();
        for (const property of element.properties) {
          if (!ts.isPropertyAssignment(property))
            fail(property, 'expected `name: value`');
          const assignment = property as ts.PropertyAssignment;
          fields.set(nameText(assignment.name), assignment.initializer);
        }
        const field = (name: string) =>
          fields.get(name) ?? fail(element, `missing \`${name}\``);
        const sites = unwrap(field('sites'));
        if (!ts.isArrayLiteralExpression(sites))
          fail(sites, '`sites` must be an array literal');
        return {
          file: literal(field('file')),
          owner: literal(field('owner')),
          kind: literal(field('kind')) as BaselineKind,
          use: literal(field('use')),
          sites: (sites as ts.ArrayLiteralExpression).elements.map(literal),
        };
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`${BASELINE_PATH}: no \`baseline\` array`);
  return found;
}

function git(root: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The base commit's baseline, or null when that commit predates the gate. */
export function baseBaseline(root: string, commit: string) {
  try {
    git(root, ['cat-file', '-e', `${commit}:${BASELINE_PATH}`]);
  } catch {
    return null;
  }
  return parseBaseline(git(root, ['show', `${commit}:${BASELINE_PATH}`]));
}

const quote = (text: string) =>
  text.includes('`') || text.includes('${')
    ? JSON.stringify(text)
    : `String.raw\`${text}\``;

/** The CLI: prints the summary and failures, returns the exit code. */
export function runGate(root: string, argv: readonly string[]) {
  const option = (name: string) =>
    argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const baseline = parseBaseline(
    readFileSync(join(root, BASELINE_PATH), 'utf8'),
  );
  const report = scanUserTextMatches(root);
  const check = checkBaseline(report, baseline);

  // Base commit: explicit, or the merge base with origin/main when there is one.
  const explicitBase = option('--base');
  let base: string | undefined;
  try {
    base = git(root, [
      'rev-parse',
      '--verify',
      explicitBase
        ? `${explicitBase}^{commit}`
        : git(root, ['merge-base', 'HEAD', 'origin/main']).trim(),
    ]).trim();
  } catch (error) {
    if (explicitBase) {
      console.error(`cannot resolve --base ${explicitBase}: ${String(error)}`);
      return 2;
    }
  }
  const before = base ? baseBaseline(root, base) : null;
  const growth = before ? baselineGrowth(baseline, before) : [];

  if (argv.includes('--json')) {
    console.log(
      JSON.stringify({ ...check, growth, sites: report.sites }, null, 2),
    );
  } else if (argv.includes('--list')) {
    const remaining = new Map<string, BaselineEntry[]>();
    for (const entry of baseline)
      for (const text of entry.sites) {
        const id = key(entry.file, entry.owner, text);
        remaining.set(id, [...(remaining.get(id) ?? []), entry]);
      }
    for (const site of report.sites) {
      const entry = site.exemption
        ? undefined
        : remaining.get(key(site.file, site.owner, site.text))?.shift();
      const status = site.exemption
        ? `exempt:${site.exemption.category}`
        : entry
          ? `baseline:${entry.kind}`
          : 'NEW';
      console.log(
        `${site.file}:${site.line}\t${site.owner}\t${status}\t${site.text}`,
      );
    }
  }

  const failures = [
    ...check.problems.map(
      (problem) => `${problem.file}:${problem.line} ${problem.problem}`,
    ),
  ];
  if (check.added.length)
    failures.push(
      [
        'Chinese wording matched outside the baseline (MET-220 R1, MET-210 #2):',
        ...check.added.map(
          (site) =>
            `  ${site.file}:${site.line} ${site.owner}\n      ${site.text}`,
        ),
        "  Understanding the user is the model's job; a miss must reach the model or a",
        '  confirmation card, not a refusal. A match that only lets a clear format through,',
        "  reads the system's own fixed text, or only changes display may carry, directly",
        '  above it, a reason a reviewer can check:',
        ...Object.entries(EXEMPTIONS).map(
          ([category, meaning]) =>
            `    // r1-exempt(${category}): <reason>   ${meaning}`,
        ),
        `  Do not add new code to ${BASELINE_PATH}: it only shrinks.`,
      ].join('\n'),
    );
  if (check.stale.length)
    failures.push(
      [
        `Baseline sites no longer in the code; delete them from ${BASELINE_PATH}:`,
        ...check.stale.map(
          (site) => `  ${site.file} ${site.owner}\n      ${quote(site.text)}`,
        ),
      ].join('\n'),
    );
  if (growth.length)
    failures.push(
      [
        `The baseline only shrinks; ${base} did not hold:`,
        ...growth.map(
          (site) => `  ${site.file} ${site.owner}\n      ${quote(site.text)}`,
        ),
      ].join('\n'),
    );

  const exempt = report.sites.filter((site) => site.exemption).length;
  const pending = baseline
    .filter((entry) => ['reject', 'decide', 'extract'].includes(entry.kind))
    .reduce((sum, entry) => sum + entry.sites.length, 0);
  console.error(
    `files=${report.files} sites=${report.sites.length} baseline=${baseline.reduce((sum, entry) => sum + entry.sites.length, 0)} (#2 pending ${pending}) exempt=${exempt} ` +
      (base
        ? before
          ? `base=${base.slice(0, 12)}`
          : `base=${base.slice(0, 12)} (no baseline there yet; nothing to compare)`
        : 'base=none (no origin/main; pass --base to compare)'),
  );
  for (const failure of failures) console.error(`\n${failure}`);
  return failures.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = runGate(process.cwd(), process.argv.slice(2));
