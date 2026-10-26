/**
 * Gate on matching the user's wording (MET-210 #2, MET-220 R1).
 *
 * R1: understanding the user is the model's job, and authorization comes from
 * the request's source and a confirmation card. A regex may let one clear
 * format through; matching the user's words and refusing, failing or skipping
 * when they do not match is what this gate keeps from growing back.
 *
 * Whether a match runs on the user's words, and whether a miss refuses,
 * cannot be decided statically, so `scanUserTextMatches` over-approximates. In
 * product code (apps/ and packages/; tests, fixtures and build output
 * excluded) it reports every place that matches wording: Chinese text, or
 * English with a function word and a request word, or three function words
 * (`please install`, `don't remember`, `please do not`; see `englishWording`):
 *
 * - a regex literal with wording (escapes decoded; character-class ranges such
 *   as `[\u4e00-\u9fa5]` and `\p{Script=Han}` name a script, not wording);
 * - `RegExp(...)` / `new RegExp(...)` whose pattern evaluates to wording;
 * - a wording regex applied by name (`test`, `exec`, `match`, `replace`,
 *   `search`, `split`, ...): each application is a site, in place of the
 *   declaration, so a new caller of an existing pattern is a new site and
 *   moving a regex into a constant keeps one site per decision;
 * - a string match (`includes`, `startsWith`, `endsWith`, `indexOf`,
 *   `lastIndexOf`, `match`, `matchAll`, `search`) whose needle evaluates to
 *   wording, membership or key lookup in a wording list or table
 *   (`WORDS.includes(text)`, `new Set(WORDS).has(text)`, `TABLE[text]`,
 *   `text in TABLE`), and equality or `case` with wording.
 *
 * Names are resolved by lexical scope, through relative imports (named,
 * namespace, re-exported), through iteration (`for...of`, callbacks of
 * `some`/`find`/`map`/..., destructuring, `Object.keys/values/entries`, `Map`
 * and `Set` iterators, rule tables), through object and static class
 * properties, and through both branches of `?:`, `??` and `||`.
 *
 * Each site must be in the baseline (`user-text-regex-gate.baseline.ts`: the
 * sites that predate the gate, removed as #2 migrates them) or carry its own
 * exemption: the nearest leading comment of the site, or of the statement,
 * property, class member or `case` holding it, reads
 *
 *   // r1-exempt(<category>): <reason, on the marker line>
 *
 * with a category from `EXEMPTIONS`. One exemption covers one site. Not
 * covered: package imports (`@allrice/...`), callers of functions that hold a
 * site, single English words, and non-JavaScript sources.
 *
 *   node --import tsx scripts/user-text-regex-gate.ts [--base <commit>] [--list] [--json]
 *
 * `--base` (default: the merge base with origin/main) also fails when the
 * baseline gains a site against the base commit's baseline, and lists for
 * review what moved, changed in place, was reclassified as not R1, or gained
 * an exemption (as GitHub annotations in Actions).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
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
    '据此决定怎么做：走哪条路、默认值、错误归哪类；猜错了用户拿不到想要的结果',
  extract: '从原话里取值（时间、名称、内容），取错只影响取到的值，不拒绝',
  ...EXEMPTIONS,
} as const;
export type BaselineKind = keyof typeof BASELINE_KINDS;
const PENDING: readonly BaselineKind[] = ['reject', 'decide', 'extract'];

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
  kind: 'regex' | 'use' | 'keyword' | 'equality';
  /** Identity in the baseline: the regex as written, or the evaluated pattern, needle or list. */
  text: string;
  exemption?: Exemption;
};

export type Problem = { file: string; line: number; problem: string };

export type ScanReport = { files: number; sites: Site[]; problems: Problem[] };

const HAN = /\p{Script=Han}/u;
const MARKER = /r1-exempt\(([^)]*)\)\s*[:：]?\s*(.*)/;
const MIN_REASON = 10;
const DEPTH = 12;
/** String methods whose first argument is matched against the receiver. */
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
/** Methods that apply a regex given as their argument. */
const REGEX_ARGUMENT = new Set([
  'match',
  'matchAll',
  'replace',
  'replaceAll',
  'search',
  'split',
]);
const MEMBERSHIP = new Set([
  'includes',
  'indexOf',
  'lastIndexOf',
  'has',
  'get',
]);
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
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
/** Not product code: tests, fixtures and build output. */
const SKIPPED =
  /^(?:apps|packages)\/[^/]+\/tests?\/|(?:^|\/)(?:node_modules|dist|coverage|__tests__|fixtures?)\/|\.(?:test|spec|fixture)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;
const SOURCE = /\.[cm]?[jt]sx?$/;

/** English words that read as a request rather than a token or a message
 * (compared in lower case). */
const FUNCTION_WORDS = new Set(
  "please don't dont do not no never always only just my our your yourself me us i we you this that these those the from now by default want need must should would could".split(
    ' ',
  ),
);
const REQUEST_WORDS = new Set(
  'remember forget confirm approve cancel stop save store record retain learn delete remove install update restore revert enable disable activate schedule remind every daily weekly once use bind reference rename call reply respond be keep mind upload discuss show view explain prefer decided send'.split(
    ' ',
  ),
);

/**
 * A function word with a request word (`please install`, `don't remember`),
 * or three function words (`please do not`). Identifiers and codes such as
 * `STOP_NOT_CONFIRMED` are one token, not words.
 */
export function englishWording(text: string) {
  const words = new Set(
    (text.match(/[A-Za-z0-9_']+/g) ?? [])
      .filter((token) => !/[\d_]/.test(token))
      .map((token) => token.toLowerCase()),
  );
  const functions = [...words].filter((word) => FUNCTION_WORDS.has(word));
  const requests = [...words].filter((word) => REQUEST_WORDS.has(word));
  return (
    (functions.length >= 1 && requests.length >= 1) || functions.length >= 3
  );
}

const textWording = (text: string) => HAN.test(text) || englishWording(text);

/** Wording in a regex source: Han text, or English request words. */
export function patternWording(source: string) {
  return (
    patternHasHan(source) ||
    englishWording(
      source
        .replace(/\\[sS][*+?]?|\\[bBdDwW]/g, ' ')
        .replace(/\\(.)/gs, '$1')
        .replace(/[^A-Za-z0-9_']+/g, ' '),
    )
  );
}

/** Product sources under apps/ and packages/: tracked or new, not ignored. */
export function productFiles(root: string) {
  return git(root, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    'apps',
    'packages',
  ])
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
    ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  )
    return name.text;
  return '';
}

const functionLike = (node: ts.Node): node is ts.SignatureDeclaration =>
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

function ownerOf(node: ts.Node) {
  const names: string[] = [];
  for (let cursor = node.parent; cursor && !ts.isSourceFile(cursor);) {
    const name = declarationName(cursor);
    if (name) names.unshift(name);
    cursor = cursor.parent;
  }
  return names.join('.') || '<module>';
}

/** Statements, class members, object properties and `case` own their leading comment. */
function holdsComments(node: ts.Node) {
  return (
    ts.isStatement(node) ||
    ts.isClassElement(node) ||
    ts.isObjectLiteralElementLike(node) ||
    ts.isCaseOrDefaultClause(node)
  );
}

type Step = string | number;
/** What an expression may evaluate to: a node, a synthetic string (an object
 * key) or a synthetic tuple (an `Object.entries` item). */
type Value = ts.Node | string | readonly Value[];
type Binding =
  | { kind: 'value'; value: ts.Node; path: Step[] }
  | { kind: 'item'; source: ts.Expression; path: Step[]; iteration: string }
  | { kind: 'import'; from: string; specifier: string; name: string }
  | { kind: 'namespace'; from: string; specifier: string }
  | { kind: 'opaque' };
const OPAQUE: Binding = { kind: 'opaque' };

/** Where `name` sits inside a binding pattern, as property and index steps. */
function bindingPath(
  pattern: ts.BindingName,
  name: string,
): Step[] | undefined {
  if (ts.isIdentifier(pattern)) return pattern.text === name ? [] : undefined;
  if (ts.isObjectBindingPattern(pattern)) {
    for (const element of pattern.elements) {
      const path = bindingPath(element.name, name);
      if (path)
        return element.dotDotDotToken
          ? undefined
          : [nameText(element.propertyName ?? element.name), ...path];
    }
    return undefined;
  }
  for (const [index, element] of pattern.elements.entries()) {
    if (ts.isOmittedExpression(element)) continue;
    const path = bindingPath(element.name, name);
    if (path) return element.dotDotDotToken ? undefined : [index, ...path];
  }
  return undefined;
}

function createScanner(root: string) {
  const parsed = new Map<string, ts.SourceFile | null>();
  /** A repository source by relative path, parsed once. */
  function parse(path: string, text?: string) {
    if (parsed.has(path)) return parsed.get(path)!;
    let file: ts.SourceFile | null = null;
    if (
      SOURCE.test(path) &&
      !path.startsWith('..') &&
      (text !== undefined || existsSync(join(root, path)))
    )
      file = ts.createSourceFile(
        path,
        text ?? readFileSync(join(root, path), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        /x$/.test(path) ? ts.ScriptKind.TSX : undefined,
      );
    parsed.set(path, file);
    return file;
  }

  /** The declaration `name` refers to at `id`, by lexical scope. */
  function bindingOf(id: ts.Identifier): Binding | undefined {
    const name = id.text;
    for (let child: ts.Node = id; child.parent; child = child.parent) {
      const scope = child.parent;
      if (functionLike(scope)) {
        for (const [index, parameter] of scope.parameters.entries()) {
          const path = bindingPath(parameter.name, name);
          if (!path) continue;
          const call = scope.parent;
          return index === 0 &&
            (ts.isArrowFunction(scope) || ts.isFunctionExpression(scope)) &&
            ts.isCallExpression(call) &&
            call.arguments[0] === scope &&
            ts.isPropertyAccessExpression(call.expression) &&
            ITERATION.has(call.expression.name.text)
            ? {
                kind: 'item',
                source: call.expression.expression,
                path,
                iteration: call.expression.name.text,
              }
            : OPAQUE;
        }
        if (ts.isFunctionExpression(scope) && scope.name?.text === name)
          return OPAQUE;
      }
      if (
        ts.isForOfStatement(scope) &&
        child !== scope.expression &&
        ts.isVariableDeclarationList(scope.initializer)
      )
        for (const declaration of scope.initializer.declarations) {
          const path = bindingPath(declaration.name, name);
          if (path)
            return {
              kind: 'item',
              source: scope.expression,
              path,
              iteration: 'for-of',
            };
        }
      if (
        (ts.isForStatement(scope) || ts.isForInStatement(scope)) &&
        scope.initializer &&
        ts.isVariableDeclarationList(scope.initializer) &&
        scope.initializer.declarations.some((declaration) =>
          bindingPath(declaration.name, name),
        )
      )
        return OPAQUE;
      if (
        ts.isCatchClause(scope) &&
        scope.variableDeclaration &&
        bindingPath(scope.variableDeclaration.name, name)
      )
        return OPAQUE;
      const statements =
        ts.isSourceFile(scope) ||
        ts.isBlock(scope) ||
        ts.isModuleBlock(scope) ||
        ts.isCaseOrDefaultClause(scope)
          ? scope.statements
          : [];
      for (const statement of statements) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            const path = bindingPath(declaration.name, name);
            if (path)
              return declaration.initializer
                ? { kind: 'value', value: declaration.initializer, path }
                : OPAQUE;
          }
        } else if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isEnumDeclaration(statement)) &&
          statement.name?.text === name
        )
          return { kind: 'value', value: statement, path: [] };
        else if (
          ts.isImportDeclaration(statement) &&
          statement.importClause &&
          ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          const clause = statement.importClause;
          if (clause.name?.text === name) return OPAQUE;
          const named = clause.namedBindings;
          if (named && ts.isNamespaceImport(named))
            if (named.name.text === name)
              return {
                kind: 'namespace',
                from: scope.getSourceFile().fileName,
                specifier: statement.moduleSpecifier.text,
              };
          if (named && ts.isNamedImports(named))
            for (const element of named.elements)
              if (element.name.text === name)
                return {
                  kind: 'import',
                  from: scope.getSourceFile().fileName,
                  specifier: statement.moduleSpecifier.text,
                  name: (element.propertyName ?? element.name).text,
                };
        }
      }
    }
    return undefined;
  }

  /** The repository file a relative import names. */
  function moduleOf(from: string, specifier: string) {
    if (!specifier.startsWith('.')) return undefined;
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    const stem = base.replace(/\.[cm]?[jt]sx?$/, '');
    for (const path of [
      base,
      `${stem}.ts`,
      `${stem}.tsx`,
      `${stem}.mts`,
      `${stem}.mjs`,
      `${stem}.js`,
      `${base}/index.ts`,
    ]) {
      const file = parse(path);
      if (file) return file;
    }
    return undefined;
  }

  /** What a module exports as `name`: a declaration, or a re-export followed. */
  function exportOf(
    file: ts.SourceFile,
    name: string,
    depth = 0,
  ): ts.Node | undefined {
    if (depth > DEPTH) return undefined;
    const local = (target: string) => {
      for (const statement of file.statements) {
        if (ts.isVariableStatement(statement))
          for (const declaration of statement.declarationList.declarations)
            if (nameText(declaration.name) === target)
              return declaration.initializer;
        if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement)) &&
          statement.name?.text === target
        )
          return statement;
      }
      return undefined;
    };
    for (const statement of file.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      const from =
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? moduleOf(file.fileName, statement.moduleSpecifier.text)
          : undefined;
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements)
          if (element.name.text === name) {
            const original = (element.propertyName ?? element.name).text;
            return statement.moduleSpecifier
              ? from && exportOf(from, original, depth + 1)
              : local(original);
          }
      } else if (!clause && from) {
        const found = exportOf(from, name, depth + 1);
        if (found) return found;
      }
    }
    return local(name);
  }

  /** What `node` may evaluate to, following names, properties and items. */
  function valuesOf(node: ts.Node, depth = 0): Value[] {
    if (depth > DEPTH || !ts.isExpression(node)) return [node];
    const expression = unwrap(node);
    if (ts.isIdentifier(expression)) {
      const binding = bindingOf(expression);
      if (!binding || binding.kind === 'opaque') return [expression];
      if (binding.kind === 'import') {
        const module = moduleOf(binding.from, binding.specifier);
        const target = module && exportOf(module, binding.name);
        return target ? valuesOf(target, depth + 1) : [expression];
      }
      if (binding.kind === 'namespace')
        return [moduleOf(binding.from, binding.specifier) ?? expression];
      if (binding.kind === 'value')
        return project(
          valuesOf(binding.value, depth + 1),
          binding.path,
          depth + 1,
        );
      return project(
        valuesOf(binding.source, depth + 1).flatMap((value) =>
          elementsOf(value, depth + 1),
        ),
        binding.path,
        depth + 1,
      );
    }
    // Either branch may run: both are inspected without deciding the condition.
    if (ts.isConditionalExpression(expression))
      return [
        ...valuesOf(expression.whenTrue, depth + 1),
        ...valuesOf(expression.whenFalse, depth + 1),
      ];
    if (
      ts.isBinaryExpression(expression) &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
      ].includes(expression.operatorToken.kind)
    )
      return [
        ...valuesOf(expression.left, depth + 1),
        ...valuesOf(expression.right, depth + 1),
      ];
    const key = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : ts.isElementAccessExpression(expression) &&
          (ts.isStringLiteral(expression.argumentExpression) ||
            ts.isNumericLiteral(expression.argumentExpression))
        ? ts.isNumericLiteral(expression.argumentExpression)
          ? Number(expression.argumentExpression.text)
          : expression.argumentExpression.text
        : undefined;
    if (
      key !== undefined &&
      key !== 'source' &&
      (ts.isPropertyAccessExpression(expression) ||
        ts.isElementAccessExpression(expression))
    ) {
      const found = valuesOf(expression.expression, depth + 1).flatMap(
        (value) => property(value, key, depth + 1),
      );
      return found.length ? found : [expression];
    }
    return [expression];
  }

  function project(values: Value[], path: Step[], depth: number) {
    return path.reduce<Value[]>(
      (current, step) =>
        current.flatMap((value) => property(value, step, depth)),
      values,
    );
  }

  function property(value: Value, key: Step, depth: number): Value[] {
    if (typeof value === 'string') return [];
    if (Array.isArray(value))
      return typeof key === 'number' && key < value.length ? [value[key]] : [];
    const node = value as ts.Node;
    if (ts.isSourceFile(node)) {
      const exported = exportOf(node, String(key));
      return exported ? valuesOf(exported, depth + 1) : [];
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const member of node.properties) {
        if (ts.isPropertyAssignment(member) && nameText(member.name) === key)
          return valuesOf(member.initializer, depth + 1);
        if (
          ts.isShorthandPropertyAssignment(member) &&
          member.name.text === key
        )
          return valuesOf(member.name, depth + 1);
      }
      return [];
    }
    if (ts.isArrayLiteralExpression(node) && typeof key === 'number') {
      const element = node.elements[key];
      return element && !ts.isSpreadElement(element)
        ? valuesOf(element, depth + 1)
        : [];
    }
    if (ts.isClassDeclaration(node))
      for (const member of node.members)
        if (
          ts.isPropertyDeclaration(member) &&
          member.initializer &&
          nameText(member.name) === key &&
          member.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
          )
        )
          return valuesOf(member.initializer, depth + 1);
    return [];
  }

  /** The keys of an object literal or a `Map`, as strings. */
  function keysOf(value: Value, depth: number): string[] {
    if (typeof value === 'string' || Array.isArray(value)) return [];
    const node = value as ts.Node;
    if (ts.isObjectLiteralExpression(node))
      return node.properties.map((member) => nameText(member.name));
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Map'
    )
      return elementsOf(node, depth + 1).flatMap((entry) =>
        property(entry, 0, depth + 1).flatMap((key) =>
          stringsOf(key, depth + 1),
        ),
      );
    if (ts.isExpression(node)) {
      const values = valuesOf(node, depth + 1);
      if (values.length !== 1 || values[0] !== node)
        return values.flatMap((resolved) => keysOf(resolved, depth + 1));
    }
    return [];
  }

  /** What `node` returns: its expression body or its `return` statements. */
  function returnsOf(node: ts.Node, depth: number): Value[] {
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return [];
    if (!ts.isBlock(node.body)) return valuesOf(node.body, depth + 1);
    const found: Value[] = [];
    const visit = (child: ts.Node) => {
      if (functionLike(child)) return;
      if (ts.isReturnStatement(child) && child.expression)
        found.push(...valuesOf(child.expression, depth + 1));
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node.body, visit);
    return found;
  }

  /** The items a collection value yields when iterated. */
  function elementsOf(value: Value, depth: number): Value[] {
    if (depth > DEPTH || typeof value === 'string' || Array.isArray(value))
      return [];
    const node = value as ts.Node;
    if (!ts.isExpression(node)) return [];
    const expression = unwrap(node);
    if (ts.isArrayLiteralExpression(expression))
      return expression.elements.flatMap((element) =>
        ts.isSpreadElement(element)
          ? valuesOf(element.expression, depth + 1).flatMap((spread) =>
              elementsOf(spread, depth + 1),
            )
          : valuesOf(element, depth + 1),
      );
    if (
      ts.isNewExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      ['Set', 'Map'].includes(expression.expression.text) &&
      expression.arguments?.[0]
    )
      return valuesOf(expression.arguments[0], depth + 1).flatMap((items) =>
        elementsOf(items, depth + 1),
      );
    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression)
    ) {
      const method = expression.expression.name.text;
      const receiver = expression.expression.expression;
      const argument = expression.arguments[0];
      if (
        ts.isIdentifier(receiver) &&
        ['Object', 'Array'].includes(receiver.text)
      ) {
        if (!argument) return [];
        const targets = valuesOf(argument, depth + 1);
        if (method === 'keys')
          return targets.flatMap((target) => keysOf(target, depth + 1));
        if (method === 'values')
          return targets.flatMap((target) =>
            keysOf(target, depth + 1).flatMap((key) =>
              property(target, key, depth + 1),
            ),
          );
        if (method === 'entries')
          return targets.flatMap((target) =>
            keysOf(target, depth + 1).flatMap((key) =>
              property(target, key, depth + 1).map((item) => [key, item]),
            ),
          );
        if (method === 'from')
          return targets.flatMap((target) => elementsOf(target, depth + 1));
        return [];
      }
      const receivers = valuesOf(receiver, depth + 1);
      if (['keys', 'values', 'entries'].includes(method))
        return receivers.flatMap((target) => {
          const made =
            typeof target !== 'string' &&
            !Array.isArray(target) &&
            ts.isNewExpression(target as ts.Node) &&
            ts.isIdentifier((target as ts.NewExpression).expression)
              ? ((target as ts.NewExpression).expression as ts.Identifier).text
              : undefined;
          const items = elementsOf(target, depth + 1);
          if (made === 'Map')
            return method === 'entries'
              ? items
              : items.flatMap((entry) =>
                  property(entry, method === 'keys' ? 0 : 1, depth + 1),
                );
          if (made === 'Set')
            return method === 'entries'
              ? items.map((item) => [item, item])
              : items;
          return method === 'values'
            ? items
            : method === 'entries'
              ? items.map((item, index) => [String(index), item])
              : [];
        });
      const items = receivers.flatMap((items) => elementsOf(items, depth + 1));
      if (method === 'map' || method === 'flatMap')
        // Source items too: `.map(escapeRegExp)` keeps their text.
        return [...items, ...(argument ? returnsOf(argument, depth) : [])];
      if (method === 'concat')
        return [
          ...items,
          ...expression.arguments.flatMap((other) =>
            valuesOf(other, depth + 1).flatMap((more) => [
              ...elementsOf(more, depth + 1),
              more,
            ]),
          ),
        ];
      if (
        [
          'filter',
          'slice',
          'flat',
          'toSorted',
          'toReversed',
          'sort',
          'reverse',
        ].includes(method)
      )
        return items;
      return [];
    }
    if (
      ts.isIdentifier(expression) ||
      ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression)
    ) {
      const values = valuesOf(expression, depth + 1);
      if (values.length !== 1 || values[0] !== expression)
        return values.flatMap((resolved) => elementsOf(resolved, depth + 1));
    }
    return [];
  }

  /** One string for a template part: its only value, its alternatives, or unknown. */
  function part(node: ts.Expression, depth: number) {
    const strings = [
      ...new Set(
        valuesOf(node, depth + 1).flatMap((value) =>
          stringsOf(value, depth + 1),
        ),
      ),
    ];
    return strings.length === 1
      ? strings[0]!
      : strings.length
        ? `\${${strings.join('|')}}`
        : '${…}';
  }

  function templateText(node: ts.TemplateLiteral, raw: boolean, depth: number) {
    const text = (literal: ts.TemplateLiteralLikeNode) =>
      raw ? (literal.rawText ?? literal.text) : literal.text;
    if (ts.isNoSubstitutionTemplateLiteral(node)) return text(node);
    return node.templateSpans.reduce(
      (result, span) =>
        result + part(span.expression, depth) + text(span.literal),
      text(node.head),
    );
  }

  /** The strings a value denotes; a collection denotes its items' strings. */
  function stringsOf(value: Value, depth = 0): string[] {
    if (depth > DEPTH) return [];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value))
      return value.flatMap((item) => stringsOf(item, depth + 1));
    const node = value as ts.Node;
    if (!ts.isExpression(node)) return [];
    const expression = unwrap(node);
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression)
    )
      return [expression.text];
    if (ts.isTemplateExpression(expression))
      return [templateText(expression, false, depth)];
    if (
      ts.isTaggedTemplateExpression(expression) &&
      expression.tag.getText() === 'String.raw'
    )
      return [templateText(expression.template, true, depth)];
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    )
      return [part(expression.left, depth) + part(expression.right, depth)];
    if (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === 'source'
    )
      return valuesOf(expression.expression, depth + 1).flatMap((target) => {
        const regex = regexOf(target, depth + 1);
        return regex ? [regex.pattern] : [];
      });
    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === 'join'
    ) {
      const separator = expression.arguments[0]
        ? part(expression.arguments[0], depth)
        : ',';
      const items = valuesOf(expression.expression.expression, depth + 1)
        .flatMap((list) => elementsOf(list, depth + 1))
        .flatMap((item) => stringsOf(item, depth + 1));
      return items.length ? [items.join(separator)] : [];
    }
    const values = valuesOf(expression, depth + 1);
    if (values.length !== 1 || values[0] !== expression)
      return values.flatMap((resolved) => stringsOf(resolved, depth + 1));
    return elementsOf(expression, depth + 1).flatMap((item) =>
      stringsOf(item, depth + 1),
    );
  }

  type Regex = { node: ts.Node; text: string; pattern: string };
  /** A regex literal or `RegExp(...)`: its text and pattern. */
  function regexOf(value: Value, depth = 0): Regex | undefined {
    if (typeof value === 'string' || Array.isArray(value)) return undefined;
    const node = value as ts.Node;
    if (ts.isRegularExpressionLiteral(node))
      return {
        node,
        text: node.text,
        pattern: node.text.slice(1, node.text.lastIndexOf('/')),
      };
    if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'RegExp' &&
      node.arguments?.[0]
    ) {
      const copied = valuesOf(node.arguments[0], depth + 1)
        .map((source) => regexOf(source, depth + 1))
        .find(Boolean);
      // A copy is the regex it copies: its applications are that regex's.
      if (copied) return copied;
      const pattern = part(node.arguments[0], depth);
      const flags = node.arguments[1] ? part(node.arguments[1], depth) : '';
      return { node, text: `RegExp(/${pattern}/${flags})`, pattern };
    }
    return undefined;
  }

  /** The iteration an expression's root name walks, if any. */
  function iterationOf(node: ts.Expression): string | undefined {
    let expression = unwrap(node);
    while (
      ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression)
    )
      expression = unwrap(expression.expression);
    if (!ts.isIdentifier(expression)) return undefined;
    const binding = bindingOf(expression);
    return binding?.kind === 'item' ? binding.iteration : undefined;
  }

  const json = (value: unknown) => JSON.stringify(value);
  const unique = (strings: string[]) => [...new Set(strings)];
  /** Regexes some code applies by name: their applications are the sites. */
  const applied = new Set<ts.Node>();
  type Candidate = { site: Site; node: ts.Node; definition: boolean };

  /** First pass over one file: every match, and the regexes it applies by name. */
  function collect(path: string, file: ts.SourceFile) {
    const lineOf = (position: number) =>
      file.getLineAndCharacterOfPosition(position).line + 1;
    const candidates: Candidate[] = [];
    const add = (node: ts.Node, kind: Site['kind'], siteText: string) =>
      candidates.push({
        node,
        definition: kind === 'regex',
        site: {
          file: path,
          line: lineOf(node.getStart(file)),
          owner: ownerOf(node),
          kind,
          text: siteText,
        },
      });
    /** A needle, list or side: one string, or the strings of an iteration. */
    const describe = (node: ts.Expression, form: (item: string) => string) => {
      const strings = unique(
        valuesOf(node).flatMap((value) => stringsOf(value)),
      );
      if (!strings.some(textWording)) return undefined;
      const iteration = iterationOf(node);
      return iteration || strings.length > 1
        ? `${iteration ?? 'any'}(${form('item')}) over ${json(strings)}`
        : form(json(strings[0]));
    };
    /**
     * Wording regexes an expression applies by name (not one written right
     * there). Each application is a site, in place of the declaration, so
     * moving a regex into a constant keeps one site per decision.
     */
    const appliedRegexes = (node: ts.Expression) => {
      const found = valuesOf(node)
        .map((value) => regexOf(value))
        .filter((regex) => regex !== undefined)
        .filter((regex) => patternWording(regex.pattern));
      if (!found.length || found.some((regex) => regex.node === unwrap(node)))
        return undefined;
      for (const regex of found) applied.add(regex.node);
      return unique(found.map((regex) => regex.text));
    };

    const visit = (node: ts.Node) => {
      if (ts.isRegularExpressionLiteral(node)) {
        if (patternWording(regexOf(node)!.pattern))
          add(node, 'regex', node.text);
      } else if (
        (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'RegExp' &&
        node.arguments?.[0]
      ) {
        const argument = node.arguments[0];
        const copies = valuesOf(argument).some((value) => regexOf(value));
        const patterns = unique(
          valuesOf(argument).flatMap((value) => stringsOf(value)),
        );
        if (!copies && patterns.some(patternWording)) {
          const iteration = iterationOf(argument);
          add(
            node,
            'regex',
            iteration || patterns.length > 1
              ? `${iteration ?? 'any'}(RegExp(item)) over ${json(patterns)}`
              : regexOf(node)!.text,
          );
        }
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression;
        const argument = node.arguments[0];
        const regexArgument =
          argument && valuesOf(argument).some((value) => regexOf(value));
        const uses = ['test', 'exec'].includes(method)
          ? appliedRegexes(receiver)
          : REGEX_ARGUMENT.has(method) && argument
            ? appliedRegexes(argument)
            : undefined;
        const iteration =
          uses &&
          iterationOf(['test', 'exec'].includes(method) ? receiver : argument!);
        // Keys of a table or `Map`, items of an array or `Set`.
        const listed = MEMBERSHIP.has(method)
          ? unique(
              valuesOf(receiver).flatMap((value) => [
                ...keysOf(value, 0),
                ...elementsOf(value, 0).flatMap((item) => stringsOf(item)),
              ]),
            )
          : [];
        if (uses)
          add(
            node,
            'use',
            iteration || uses.length > 1
              ? `${iteration ?? 'any'}(${method}(item)) over ${json(uses)}`
              : `${method}(${uses[0]})`,
          );
        else if (listed.some(textWording))
          add(node, 'keyword', `${json(listed)}.${method}()`);
        else if (STRING_MATCH.has(method) && argument && !regexArgument) {
          const needle = describe(argument, (item) => `${method}(${item})`);
          if (needle) add(node, 'keyword', needle);
        }
      } else if (
        ts.isBinaryExpression(node) &&
        EQUALITY.has(node.operatorToken.kind)
      ) {
        const side =
          describe(node.right, (item) => `=== ${item}`) ??
          describe(node.left, (item) => `=== ${item}`);
        if (side) add(node, 'equality', side);
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword
      ) {
        const keys = unique(
          valuesOf(node.right).flatMap((value) => keysOf(value, 0)),
        );
        if (keys.some(textWording)) add(node, 'keyword', `in ${json(keys)}`);
      } else if (
        ts.isElementAccessExpression(node) &&
        !ts.isStringLiteral(node.argumentExpression) &&
        !ts.isNumericLiteral(node.argumentExpression)
      ) {
        const keys = unique(
          valuesOf(node.expression).flatMap((value) => keysOf(value, 0)),
        );
        if (keys.some(textWording))
          add(node, 'keyword', `[key] of ${json(keys)}`);
      } else if (ts.isCaseClause(node)) {
        const label = describe(node.expression, (item) => `case ${item}`);
        if (label) add(node, 'equality', label);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return candidates;
  }

  /**
   * Second pass, once every file has been collected: a regex applied by name
   * is not a site itself, and each match takes the exemption nearest to it.
   */
  function finish(path: string, file: ts.SourceFile, candidates: Candidate[]) {
    const text = file.text;
    const lineOf = (position: number) =>
      file.getLineAndCharacterOfPosition(position).line + 1;
    const problems: Problem[] = [];
    type Marker = {
      line: number;
      end: number;
      exemption?: Exemption;
      covers: Candidate[];
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
      const marker: Marker = { line, end: range.end, covers: [] };
      if (!Object.hasOwn(EXEMPTIONS, category))
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

    const sites: Site[] = [];
    for (const candidate of candidates) {
      const { node, site } = candidate;
      const counted = !candidate.definition || !applied.has(node);
      if (counted) sites.push(site);
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
      marker.covers.push(candidate);
      if (marker.exemption && counted) site.exemption = marker.exemption;
    }
    for (const marker of markers.values()) {
      const elsewhere = marker.covers.every(
        (candidate) => candidate.definition && applied.has(candidate.node),
      );
      if (marker.covers.length === 0)
        problems.push({
          file: path,
          line: marker.line,
          problem:
            'exemption comment covers no site: put it on its own line directly above the statement holding the match, or inline as /* ... */ right before the match, or delete it',
        });
      else if (marker.covers.length > 1)
        problems.push({
          file: path,
          line: marker.line,
          problem: `one exemption covers ${marker.covers.length} sites; give each site its own comment (/* r1-exempt(...): ... */ works inline)`,
        });
      else if (elsewhere)
        problems.push({
          file: path,
          line: marker.line,
          problem:
            'exemption on a regex that is applied by name: each application (test, match, replace, ...) is the site and needs its own exemption',
        });
    }
    // A marker the walk above cannot see (inside JSX, before a closing brace,
    // or in a string) is not silently ignored.
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
            'r1-exempt marker the gate cannot attach to code: use a // line directly above the statement holding the match, or /* ... */ right before the match itself (e.g. inside an `else if (...)` condition)',
        });
    return { sites, problems };
  }

  return { parse, collect, finish };
}

/** Every site in `files` (repository-relative), sorted by file and line. */
export function scanUserTextMatches(
  root: string,
  files: readonly string[] = productFiles(root),
): ScanReport {
  const scanner = createScanner(root);
  const collected = files.flatMap((path) => {
    const file = scanner.parse(path);
    return file
      ? [{ path, file, candidates: scanner.collect(path, file) }]
      : [];
  });
  const sites: Site[] = [];
  const problems: Problem[] = [];
  for (const { path, file, candidates } of collected) {
    const result = scanner.finish(path, file, candidates);
    sites.push(...result.sites);
    problems.push(...result.problems);
  }
  return { files: files.length, sites, problems };
}

const key = (file: string, owner: string, text: string) =>
  `${file}\0${owner}\0${text}`;

/** Where each parsed baseline entry starts in the baseline file. */
const entryLines = new WeakMap<BaselineEntry, number>();

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
    const where = {
      file: BASELINE_PATH,
      line: entryLines.get(entry) ?? 0,
    };
    const name = `entry ${index + 1} (${entry.file} ${entry.owner})`;
    if (!Object.hasOwn(BASELINE_KINDS, entry.kind))
      problems.push({ ...where, problem: `${name}: unknown kind` });
    if ([...entry.use.trim()].length < MIN_REASON)
      problems.push({
        ...where,
        problem: `${name}: \`use\` must say what the match decides`,
      });
    if (!entry.sites.length)
      problems.push({ ...where, problem: `${name}: no sites` });
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

type Listed = { file: string; owner: string; kind: BaselineKind; text: string };
export type BaselineChange = {
  /** Sites the base did not hold: these fail. */
  growth: Listed[];
  /** Matched with a base site for review: moved, edited in place, or relaxed out of #2. */
  notices: { site: Listed; from: Listed; change: string }[];
};

const sitesOf = (entries: readonly BaselineEntry[]) =>
  entries.flatMap((entry) =>
    entry.sites.map((text): Listed => ({
      file: entry.file,
      owner: entry.owner,
      kind: entry.kind,
      text,
    })),
  );

/**
 * Compares the baseline with the base commit's as a maximum matching, so the
 * order of entries never decides the result. A current site matches a base
 * site with the same file, owner and text; or, of the same kind, with the same
 * text in the same file or owner (moved); or in the same file and owner
 * (edited in place). A site with no match is growth. So no owner, and no #2
 * kind, gains a site, and a not-R1 entry never pays for a new #2 one.
 */
export function baselineChange(
  current: readonly BaselineEntry[],
  base: readonly BaselineEntry[],
): BaselineChange {
  const now = sitesOf(current);
  const before = sitesOf(base);
  const exact = (a: Listed, b: Listed) =>
    a.file === b.file &&
    a.owner === b.owner &&
    a.text === b.text &&
    // Reclassifying a not-R1 site into #2 says the code now refuses: new.
    (PENDING.includes(b.kind) || !PENDING.includes(a.kind));
  const edge = (a: Listed, b: Listed) =>
    exact(a, b) ||
    (a.kind === b.kind &&
      ((a.text === b.text && (a.file === b.file || a.owner === b.owner)) ||
        (a.file === b.file && a.owner === b.owner)));
  // Kuhn's augmenting paths; exact pairs are tried first.
  const adjacent = now.map((site) =>
    before
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => edge(site, candidate))
      .sort(
        (a, b) =>
          Number(exact(site, b.candidate)) - Number(exact(site, a.candidate)),
      )
      .map(({ index }) => index),
  );
  const owner = new Array<number>(before.length).fill(-1);
  const augment = (site: number, seen: Set<number>): boolean => {
    for (const index of adjacent[site]!) {
      if (seen.has(index)) continue;
      seen.add(index);
      if (owner[index] === -1 || augment(owner[index]!, seen)) {
        owner[index] = site;
        return true;
      }
    }
    return false;
  };
  for (let site = 0; site < now.length; site++) augment(site, new Set());
  const pair = new Map<number, number>();
  owner.forEach((site, index) => site >= 0 && pair.set(site, index));
  const growth: Listed[] = [];
  const notices: BaselineChange['notices'] = [];
  now.forEach((site, index) => {
    const matched = pair.get(index);
    if (matched === undefined) return void growth.push(site);
    const from = before[matched]!;
    const change = [
      from.text !== site.text ? 'edited in place' : '',
      from.file !== site.file || from.owner !== site.owner ? 'moved' : '',
      PENDING.includes(from.kind) && !PENDING.includes(site.kind)
        ? `reclassified ${from.kind} → ${site.kind} (leaves #2)`
        : '',
    ]
      .filter(Boolean)
      .join(', ');
    if (change) notices.push({ site, from, change });
  });
  return { growth, notices };
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
  const lineOf = (node: ts.Node) =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const fail = (node: ts.Node, message: string): never => {
    throw new Error(`${BASELINE_PATH}:${lineOf(node)}: ${message}`);
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
        const entry: BaselineEntry = {
          file: literal(field('file')),
          owner: literal(field('owner')),
          kind: literal(field('kind')) as BaselineKind,
          use: literal(field('use')),
          sites: (sites as ts.ArrayLiteralExpression).elements.map(literal),
        };
        entryLines.set(entry, lineOf(element));
        return entry;
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
    maxBuffer: 256 * 1024 * 1024,
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

/** Exemption comments added since the base commit: the diff, and new files. */
export function addedExemptions(root: string, commit: string) {
  const added: { file: string; line: number; text: string }[] = [];
  let file = '';
  let line = 0;
  for (const row of git(root, [
    'diff',
    '--no-color',
    '--unified=0',
    commit,
    '--',
    'apps',
    'packages',
  ]).split('\n')) {
    if (row.startsWith('+++ ')) file = row.replace(/^\+\+\+ (?:b\/)?/, '');
    else if (row.startsWith('@@')) line = Number(/\+(\d+)/.exec(row)?.[1] ?? 0);
    else if (row.startsWith('+')) {
      if (row.includes('r1-exempt('))
        added.push({ file, line, text: row.slice(1).trim() });
      line += 1;
    }
  }
  for (const path of git(root, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    'apps',
    'packages',
  ]).split('\0')) {
    if (!SOURCE.test(path)) continue;
    readFileSync(join(root, path), 'utf8')
      .split('\n')
      .forEach((row, index) => {
        if (row.includes('r1-exempt('))
          added.push({ file: path, line: index + 1, text: row.trim() });
      });
  }
  return added;
}

const quote = (text: string) =>
  text.includes('`') || text.includes('${')
    ? JSON.stringify(text)
    : `String.raw\`${text}\``;

/** The CLI: prints the summary and failures, returns the exit code. */
export function runGate(root: string, argv: readonly string[]) {
  let explicitBase: string | undefined;
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--base') {
      explicitBase = argv[++index];
      if (!explicitBase || explicitBase.startsWith('-')) {
        console.error('--base needs a commit');
        return 2;
      }
    } else if (argument === '--list' || argument === '--json')
      flags.add(argument);
    else {
      console.error(
        `unknown argument ${argument}; usage: [--base <commit>] [--list] [--json]`,
      );
      return 2;
    }
  }
  const baseline = parseBaseline(
    readFileSync(join(root, BASELINE_PATH), 'utf8'),
  );
  const report = scanUserTextMatches(root);
  const check = checkBaseline(report, baseline);

  // Base commit: explicit, or the merge base with origin/main when there is one.
  let base: string | undefined;
  try {
    base = git(root, [
      'rev-parse',
      '--verify',
      `${explicitBase ?? git(root, ['merge-base', 'HEAD', 'origin/main']).trim()}^{commit}`,
    ]).trim();
  } catch (error) {
    if (explicitBase) {
      console.error(`cannot resolve --base ${explicitBase}: ${String(error)}`);
      return 2;
    }
  }
  const before = base ? baseBaseline(root, base) : null;
  const change = before
    ? baselineChange(baseline, before)
    : { growth: [], notices: [] };
  const exemptions = base ? addedExemptions(root, base) : [];

  if (flags.has('--json')) {
    console.log(
      JSON.stringify(
        { ...check, ...change, exemptions, sites: report.sites },
        null,
        2,
      ),
    );
  } else if (flags.has('--list')) {
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
      (problem) =>
        `${problem.file}${problem.line ? `:${problem.line}` : ''} ${problem.problem}`,
    ),
  ];
  if (check.added.length)
    failures.push(
      [
        'Wording matched outside the baseline (MET-220 R1, MET-210 #2):',
        ...check.added.map(
          (site) =>
            `  ${site.file}:${site.line} ${site.owner}\n      ${site.text}`,
        ),
        "  Understanding the user is the model's job; a miss must reach the model or a",
        '  confirmation card, not a refusal. A match that only lets a clear format through,',
        "  reads the system's own fixed text or another system's, or only changes display",
        '  may carry, on its own line directly above, a reason a reviewer can check:',
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
  if (change.growth.length)
    failures.push(
      [
        `The baseline only shrinks; ${base} held no matching site (same text and kind in the same file or owner, or the same file and owner) for:`,
        ...change.growth.map(
          (site) =>
            `  ${site.file} ${site.owner} (${site.kind})\n      ${quote(site.text)}`,
        ),
      ].join('\n'),
    );

  // Allowed, but each one is a reviewer's call under R1.
  const review = [
    ...change.notices.map(({ site, from, change: what }) => ({
      file: BASELINE_PATH,
      line: entryLines.get(
        baseline.find(
          (entry) =>
            entry.file === site.file &&
            entry.owner === site.owner &&
            entry.sites.includes(site.text),
        )!,
      ),
      message: `baseline ${what}: ${site.file} ${site.owner} (${site.kind}) was ${from.file} ${from.owner} (${from.kind}) ${quote(from.text)}`,
    })),
    ...exemptions.map((exemption) => ({
      file: exemption.file,
      line: exemption.line,
      message: `new exemption: ${exemption.text}`,
    })),
  ];
  if (review.length) {
    console.error(
      `\nReview under MET-220 R1 (allowed by the gate):\n${review
        .map(
          (item) =>
            `  ${item.file}${item.line ? `:${item.line}` : ''} ${item.message}`,
        )
        .join('\n')}`,
    );
    if (process.env.GITHUB_ACTIONS === 'true')
      for (const item of review)
        console.log(
          `::warning file=${item.file}${item.line ? `,line=${item.line}` : ''},title=R1 review::${item.message.replace(/\r?\n/g, ' ')}`,
        );
  }

  const exempt = report.sites.filter((site) => site.exemption).length;
  const pending = baseline
    .filter((entry) => PENDING.includes(entry.kind))
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
