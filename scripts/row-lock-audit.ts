/**
 * Static row-lock audit (MET-210 #4).
 *
 * `routeLocks` follows the TypeScript call graph from apps/web route handlers
 * into this repository and reports every SQL row-lock clause
 * (`FOR UPDATE / NO KEY UPDATE / SHARE / KEY SHARE`) and advisory lock
 * (`pg_advisory_xact_lock` and variants) a handler can reach.
 * `inventory` classifies every row-lock clause in the repository by the
 * transactions that can reach it: a lock reached only by transactions that
 * never write protects nothing and belongs to a read path.
 *
 * The walk is context sensitive for literal arguments: `handle(request,
 * 'read')`, `readRun(tx, id, { lock: false })` or `request.method === 'GET'`
 * prune the branches they decide, which is how this repository separates read
 * paths from write paths (``${lock ? sql`for share` : sql``}``). Branches on
 * runtime data are all followed, so results over-approximate. A call through
 * an interface-typed value follows the object-literal members implementing it
 * (narrowed to the factory that returned the value); one with no such member
 * is reported in `unresolved`, not followed. Callbacks passed as parameters
 * and Worker job registries are outside the walk.
 *
 *   node --import tsx scripts/row-lock-audit.ts GET [--chain] [--route <part>] [--json] [--raw]
 *   node --import tsx scripts/row-lock-audit.ts --inventory [--raw]
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/** Row-lock clauses and advisory locks: either makes a reader wait for, or
 * hold up, a writer of the same rows or key. */
export const ROW_LOCK =
  /\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b|\bpg_(?:try_)?advisory_(?:xact_)?lock(?:_shared)?\s*\(/i;
const SQL_WRITE =
  /\b(?:insert\s+into|delete\s+from|merge\s+into|truncate\s|update\s+(?:only\s+)?[\w."]+(?:\s+(?:as\s+)?\w+)?\s+set\b)/i;
const SQL_TAG = /^(?:tx|transaction|trx|sql|db|database|client|t)$/i;

export type RouteMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export const WRITE_METHODS: readonly RouteMethod[] = [
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
];

export type LockSite = {
  /** Repository-relative path. */
  file: string;
  /** Line of the SQL template that carries the clause. */
  line: number;
  /** The clause as written, for example `for share of r`. */
  clause: string;
  /** Nearest named function that contains the clause. */
  owner: string;
};

export type ReachedLock = LockSite & {
  /** `<route file> <METHOD>` handlers that reach this site. */
  routes: string[];
  /** One call chain from a handler to the clause (pinned literals shown). */
  chain: string[];
};

export type RouteLockReport = {
  entries: number;
  reached: ReachedLock[];
  /** Interface-typed call targets on these routes that were not followed. */
  unresolved: string[];
  /** `<route> <file> <owner>` barriers some handler actually called. */
  stopped: string[];
};

/** A function one route calls that runs its own writing transaction; the walk
 * does not enter it from that route (its locks fence those writes). */
export type RouteBarrier = { route: string; file: string; owner: string };

export type InventorySite = LockSite & {
  getRoutes: number;
  writeRoutes: number;
  /** Transactions reaching the site that can never write. */
  readTransactions: number;
  /** Transactions reaching the site that can write. */
  writeTransactions: number;
  category:
    'get_path' | 'read_transaction' | 'write_transaction' | 'no_transaction';
};

type Value = boolean | string | number | null | undefined;
type Known = { value: Value };
type Env = ReadonlyMap<string, Value>;
type State = { node: ts.Node; env: Env; key: string };
type Summary = {
  locks: string[];
  writes: boolean;
  callees: State[];
  unresolved: string[];
};

const EMPTY: Env = new Map();
const MAX_SPECIALIZATIONS = 512;

function walk(dir: string, accept: (path: string) => boolean, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, accept, out);
    else if (accept(path)) out.push(path);
  }
  return out;
}

function functionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** Declarations run when referenced, never because their container ran. */
function boundary(node: ts.Node) {
  if (ts.isClassLike(node) || ts.isFunctionDeclaration(node)) return true;
  if (ts.isMethodDeclaration(node) || ts.isAccessor(node)) return true;
  if (ts.isPropertyDeclaration(node)) return true;
  if (ts.isPropertyAssignment(node) && functionLike(node.initializer))
    return true;
  return (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    node.parent.initializer === node
  );
}

const truthy = (value: Value) => Boolean(value);

function sqlText(node: ts.TaggedTemplateExpression) {
  const template = node.template;
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
  return [
    template.head.text,
    ...template.templateSpans.map((span) => span.literal.text),
  ].join(' $ ');
}

function clauseOf(text: string) {
  const match = ROW_LOCK.exec(text)!;
  if (match[0].startsWith('pg_'))
    return match[0].replace(/\s*\($/, '').toLowerCase();
  return text
    .slice(match.index)
    .split(/[`$;\n]/)[0]!
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function createRowLockAudit(
  root: string,
  options: { inventory?: boolean } = {},
) {
  const routes = walk(
    join(root, 'apps/web/app/api'),
    (path) => path.endsWith('/route.ts'),
    [],
  );
  const sources = options.inventory
    ? [
        'packages/database/src',
        'apps/worker/src',
        'apps/web/lib',
        'apps/web/app',
      ]
        .map((dir) => join(root, dir))
        .flatMap((dir) =>
          walk(
            dir,
            (path) =>
              /\.tsx?$/.test(path) &&
              !/\.(test|fixture|d)\.tsx?$/.test(path) &&
              !path.includes('/test/'),
            [],
          ),
        )
    : routes;
  const configPath = join(root, 'apps/web/tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
  );
  const program = ts.createProgram([...new Set([...routes, ...sources])], {
    ...parsed.options,
    noEmit: true,
    incremental: false,
    plugins: [],
  });
  const checker = program.getTypeChecker();
  const own = (file: ts.SourceFile) =>
    file.fileName.startsWith(root) && !file.fileName.includes('/node_modules/');

  function label(node: ts.Node) {
    const file = node.getSourceFile();
    let name = '';
    for (let cursor: ts.Node | undefined = node; cursor && !name;) {
      if (
        (ts.isFunctionDeclaration(cursor) ||
          ts.isMethodDeclaration(cursor) ||
          ts.isAccessor(cursor)) &&
        cursor.name
      )
        name = cursor.name.getText(file);
      else if (
        (ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)) &&
        (ts.isVariableDeclaration(cursor.parent) ||
          ts.isPropertyAssignment(cursor.parent) ||
          ts.isPropertyDeclaration(cursor.parent))
      )
        name = cursor.parent.name.getText(file);
      else if (
        cursor !== node &&
        ts.isVariableDeclaration(cursor) &&
        ts.isSourceFile(cursor.parent.parent.parent)
      )
        name = cursor.name.getText(file);
      cursor = cursor.parent;
    }
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    return {
      file: relative(root, file.fileName),
      line: line + 1,
      name: name || '<anonymous>',
    };
  }

  function symbolOf(node: ts.Node) {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  }

  /** The executable node for a declaration, or null when it has no body here. */
  function target(declaration: ts.Declaration, depth = 0): ts.Node | null {
    if (!own(declaration.getSourceFile()) || depth > 8) return null;
    if (functionLike(declaration)) return declaration.body ? declaration : null;
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const value =
        checker.getShorthandAssignmentValueSymbol(
          declaration,
        )?.valueDeclaration;
      return value ? target(value, depth + 1) : null;
    }
    if (
      (ts.isVariableDeclaration(declaration) ||
        ts.isPropertyAssignment(declaration) ||
        ts.isPropertyDeclaration(declaration)) &&
      declaration.initializer
    ) {
      let value: ts.Expression = declaration.initializer;
      while (
        ts.isParenthesizedExpression(value) ||
        ts.isAsExpression(value) ||
        ts.isSatisfiesExpression(value) ||
        ts.isNonNullExpression(value)
      )
        value = value.expression;
      if (functionLike(value)) return value;
      // `export const GET = withAuth(handler)` runs its initializer; a local
      // `const rows = await tx\`…\`` is data, already scanned in place.
      const moduleLevel =
        !ts.isVariableDeclaration(declaration) ||
        ts.isSourceFile(declaration.parent.parent.parent);
      if (
        moduleLevel &&
        (ts.isCallExpression(value) ||
          ts.isAwaitExpression(value) ||
          ts.isNewExpression(value) ||
          ts.isConditionalExpression(value))
      )
        return value;
      // `const identity = assertIdentity` aliases keep the call's arguments.
      if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value))
        for (const aliased of symbolOf(
          ts.isIdentifier(value) ? value : value.name,
        )?.declarations ?? []) {
          const next = target(aliased, depth + 1);
          if (next) return next;
        }
    }
    return null;
  }

  function evaluate(node: ts.Expression, env: Env): Known | null {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node)
    )
      return evaluate(node.expression, env);
    switch (node.kind) {
      case ts.SyntaxKind.TrueKeyword:
        return { value: true };
      case ts.SyntaxKind.FalseKeyword:
        return { value: false };
      case ts.SyntaxKind.NullKeyword:
        return { value: null };
    }
    if (ts.isConditionalExpression(node)) {
      const condition = evaluate(node.condition, env);
      if (!condition) return null;
      return evaluate(
        truthy(condition.value) ? node.whenTrue : node.whenFalse,
        env,
      );
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return { value: node.text };
    if (ts.isNumericLiteral(node)) return { value: Number(node.text) };
    if (ts.isIdentifier(node)) {
      if (node.text === 'undefined') return { value: undefined };
      return env.has(node.text) ? { value: env.get(node.text) } : null;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression)
    ) {
      const key = `${node.expression.text}.${node.name.text}`;
      if (env.has(key)) return { value: env.get(key) };
      // `options?.lock` when the caller passed no `options` at all.
      const base = env.get(node.expression.text);
      return node.questionDotToken &&
        env.has(node.expression.text) &&
        (base === undefined || base === null)
        ? { value: undefined }
        : null;
    }
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken
    ) {
      const operand = evaluate(node.operand, env);
      return operand ? { value: !truthy(operand.value) } : null;
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      const left = evaluate(node.left, env);
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
        if (left && !truthy(left.value)) return left;
        return left ? evaluate(node.right, env) : null;
      }
      if (operator === ts.SyntaxKind.BarBarToken) {
        if (left && truthy(left.value)) return left;
        return left ? evaluate(node.right, env) : null;
      }
      if (operator === ts.SyntaxKind.QuestionQuestionToken) {
        if (left && left.value !== null && left.value !== undefined)
          return left;
        return left ? evaluate(node.right, env) : null;
      }
      const right = evaluate(node.right, env);
      if (!left || !right) return null;
      switch (operator) {
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
          return { value: left.value === right.value };
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:
          return { value: left.value !== right.value };
        case ts.SyntaxKind.EqualsEqualsToken:
          return { value: left.value == right.value };
        case ts.SyntaxKind.ExclamationEqualsToken:
          return { value: left.value != right.value };
      }
    }
    return null;
  }

  /** Literal parameter values a call site passes to `callee`. */
  function calleeEnv(
    callee: ts.Node,
    args: readonly ts.Expression[],
    env: Env,
  ): Env {
    if (!functionLike(callee)) return EMPTY;
    const out = new Map<string, Value>();
    callee.parameters.forEach((parameter, index) => {
      if (parameter.dotDotDotToken) return;
      const arg = args[index];
      let known = arg ? evaluate(arg, env) : { value: undefined };
      if (known && known.value === undefined && parameter.initializer)
        known = evaluate(parameter.initializer, EMPTY);
      if (ts.isIdentifier(parameter.name)) {
        const name = parameter.name.text;
        if (known) out.set(name, known.value);
        if (arg && ts.isIdentifier(arg))
          for (const [key, value] of env)
            if (key.startsWith(`${arg.text}.`))
              out.set(`${name}${key.slice(arg.text.length)}`, value);
        if (
          arg &&
          ts.isObjectLiteralExpression(arg) &&
          !arg.properties.some(ts.isSpreadAssignment)
        )
          for (const property of arg.properties) {
            if (
              !(
                ts.isPropertyAssignment(property) ||
                ts.isShorthandPropertyAssignment(property)
              ) ||
              !ts.isIdentifier(property.name)
            )
              continue;
            const value = evaluate(
              ts.isPropertyAssignment(property)
                ? property.initializer
                : property.name,
              env,
            );
            if (value) out.set(`${name}.${property.name.text}`, value.value);
          }
        return;
      }
      if (!ts.isObjectBindingPattern(parameter.name)) return;
      const literal =
        arg && ts.isObjectLiteralExpression(arg) ? arg : undefined;
      if (literal?.properties.some(ts.isSpreadAssignment)) return;
      // An argument the walk cannot evaluate is unknown, not absent.
      const missing = !arg || (known !== null && known.value === undefined);
      for (const element of parameter.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const key = (element.propertyName ?? element.name).getText();
        let value: Known | null = null;
        if (literal) {
          const property = literal.properties.find(
            (candidate) =>
              (ts.isPropertyAssignment(candidate) ||
                ts.isShorthandPropertyAssignment(candidate)) &&
              candidate.name.getText() === key,
          );
          if (!property) value = { value: undefined };
          else if (ts.isPropertyAssignment(property))
            value = evaluate(property.initializer, env);
          else value = evaluate(property.name, env);
        } else if (missing) value = { value: undefined };
        if (value && value.value === undefined && element.initializer)
          value = evaluate(element.initializer, EMPTY);
        if (value) out.set(element.name.text, value.value);
      }
    });
    return out;
  }

  /** True when an env-decided branch between `root` and `node` excludes it. */
  function pruned(node: ts.Node, root: ts.Node, env: Env) {
    for (let child = node; child !== root && child.parent;) {
      const parent: ts.Node = child.parent;
      if (ts.isIfStatement(parent) && child !== parent.expression) {
        const condition = evaluate(parent.expression, env);
        if (
          condition &&
          truthy(condition.value) === (child === parent.elseStatement)
        )
          return true;
      } else if (
        ts.isConditionalExpression(parent) &&
        child !== parent.condition
      ) {
        const condition = evaluate(parent.condition, env);
        if (
          condition &&
          truthy(condition.value) === (child === parent.whenFalse)
        )
          return true;
      } else if (ts.isBinaryExpression(parent) && child === parent.right) {
        const operator = parent.operatorToken.kind;
        const left = evaluate(parent.left, env);
        if (
          left &&
          ((operator === ts.SyntaxKind.AmpersandAmpersandToken &&
            !truthy(left.value)) ||
            (operator === ts.SyntaxKind.BarBarToken && truthy(left.value)))
        )
          return true;
      }
      child = parent;
    }
    return false;
  }

  /**
   * Adds locals the env decides: `const write = method !== 'GET'`, or
   * `let action = 'status'` reassigned only in branches the env excludes.
   */
  function withLocals(node: ts.Node, base: Env): Env {
    const out = new Map(base);
    const body = functionLike(node) ? node.body : node;
    if (!body) return out;
    const assigned = new Map<string, ts.Node[]>();
    const declared = new Map<string, number>();
    const order: ts.VariableDeclaration[] = [];
    const note = (name: string, write: ts.Node) =>
      assigned.set(name, [...(assigned.get(name) ?? []), write]);
    const collect = (current: ts.Node, local: boolean) => {
      if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        current.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isIdentifier(current.left)
      )
        note(current.left.text, current);
      if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        current.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isPropertyAccessExpression(current.left) &&
        ts.isIdentifier(current.left.expression)
      )
        note(
          `${current.left.expression.text}.${current.left.name.text}`,
          current,
        );
      if (
        (ts.isPrefixUnaryExpression(current) ||
          ts.isPostfixUnaryExpression(current)) &&
        (current.operator === ts.SyntaxKind.PlusPlusToken ||
          current.operator === ts.SyntaxKind.MinusMinusToken) &&
        ts.isIdentifier(current.operand)
      )
        note(current.operand.text, current);
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
        declared.set(
          current.name.text,
          (declared.get(current.name.text) ?? 0) + 1,
        );
        if (local) order.push(current);
      }
      const nested =
        current !== body && (functionLike(current) || ts.isClassLike(current));
      ts.forEachChild(current, (child) => collect(child, local && !nested));
    };
    collect(body, true);
    // A parameter (or its property) assigned anywhere in the body is no longer
    // the literal the call site passed.
    for (const name of assigned.keys())
      for (const key of [...out.keys()])
        if (key === name || key.startsWith(`${name}.`)) out.delete(key);
    // `const { lock } = options` where the call pinned `options.lock`.
    const destructure = (current: ts.Node) => {
      if (
        ts.isVariableDeclaration(current) &&
        ts.isObjectBindingPattern(current.name) &&
        current.initializer &&
        ts.isIdentifier(current.initializer)
      )
        for (const element of current.name.elements) {
          if (!ts.isIdentifier(element.name) || element.dotDotDotToken)
            continue;
          const key = `${current.initializer.text}.${(element.propertyName ?? element.name).getText()}`;
          if (out.has(key) && !base.has(element.name.text))
            out.set(element.name.text, out.get(key));
        }
      if (
        current !== body &&
        (functionLike(current) || ts.isClassLike(current))
      )
        return;
      ts.forEachChild(current, destructure);
    };
    destructure(body);
    for (const declaration of order) {
      const name = (declaration.name as ts.Identifier).text;
      if (!declaration.initializer || declared.get(name) !== 1) continue;
      if (base.has(name)) continue;
      const known = evaluate(declaration.initializer, out);
      if (!known) continue;
      const constant =
        (declaration.parent.flags & ts.NodeFlags.Const) !== 0 ||
        (assigned.get(name) ?? []).every((write) => pruned(write, body, out));
      if (constant) out.set(name, known.value);
    }
    return out;
  }

  let implementationIndex: Map<ts.Node, ts.Node[]> | undefined;
  /**
   * Object-literal members that implement an interface member, found through
   * each literal's contextual type (`createX(): Store`, typed options, …).
   */
  function implementations(signature: ts.Declaration) {
    if (!implementationIndex) {
      implementationIndex = new Map();
      for (const file of program.getSourceFiles()) {
        if (!own(file) || file.isDeclarationFile) continue;
        const visit = (node: ts.Node) => {
          if (ts.isObjectLiteralExpression(node)) {
            const type = checker.getContextualType(node);
            if (type)
              for (const property of node.properties) {
                if (!property.name || ts.isSpreadAssignment(property)) continue;
                const name = property.name.getText(file);
                const member = type.getProperty(name);
                for (const declaration of member?.declarations ?? []) {
                  if (
                    !ts.isMethodSignature(declaration) &&
                    !ts.isPropertySignature(declaration)
                  )
                    continue;
                  const list = implementationIndex!.get(declaration) ?? [];
                  list.push(property);
                  implementationIndex!.set(declaration, list);
                }
              }
          }
          ts.forEachChild(node, visit);
        };
        visit(file);
      }
    }
    return implementationIndex.get(signature) ?? [];
  }

  const nodeIds = new Map<ts.Node, number>();
  const specializations = new Map<ts.Node, Set<string>>();
  const summaries = new Map<string, Summary>();
  const siteInfo = new Map<string, LockSite>();

  function envKey(env: Env) {
    return JSON.stringify(
      [...env]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, v === undefined ? { undefined: true } : v]),
    );
  }

  function stateOf(node: ts.Node, env: Env): State {
    let id = nodeIds.get(node);
    if (id === undefined) nodeIds.set(node, (id = nodeIds.size));
    let seen = specializations.get(node);
    if (!seen) specializations.set(node, (seen = new Set()));
    let key = envKey(env);
    if (!seen.has(key) && seen.size >= MAX_SPECIALIZATIONS) {
      env = EMPTY;
      key = envKey(env);
    }
    seen.add(key);
    return { node, env, key: `${id}|${key}` };
  }

  function siteKey(node: ts.TaggedTemplateExpression, text: string) {
    const file = node.getSourceFile();
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    const clause = clauseOf(text);
    const key = `${relative(root, file.fileName)}:${line + 1}:${clause}`;
    if (!siteInfo.has(key))
      siteInfo.set(key, {
        file: relative(root, file.fileName),
        line: line + 1,
        clause,
        owner: label(node).name,
      });
    return key;
  }

  function summarize(state: State): Summary {
    const cached = summaries.get(state.key);
    if (cached) return cached;
    const summary: Summary = {
      locks: [],
      writes: false,
      callees: [],
      unresolved: [],
    };
    summaries.set(state.key, summary);
    const env = withLocals(state.node, state.env);

    /** Enter the executable declarations behind one reference. */
    const enter = (
      found: readonly ts.Declaration[],
      call: ts.CallExpression | undefined,
      receiverExpression: ts.Expression | undefined,
      self?: ts.Node,
    ) => {
      const declarations: ts.Declaration[] = [];
      for (const declaration of found) {
        // `const { readX } = await import('./x.ts')` or `= helpers`: follow
        // the property of the destructured value's type.
        if (
          ts.isBindingElement(declaration) &&
          ts.isObjectBindingPattern(declaration.parent)
        ) {
          const key = (declaration.propertyName ?? declaration.name).getText();
          let property = checker
            .getTypeAtLocation(declaration.parent)
            .getProperty(key);
          if (property && property.flags & ts.SymbolFlags.Alias)
            property = checker.getAliasedSymbol(property);
          declarations.push(...(property?.declarations ?? []));
        } else declarations.push(declaration);
      }
      for (const declaration of declarations) {
        if (declaration === self) continue;
        if (
          call &&
          (ts.isMethodSignature(declaration) ||
            ts.isPropertySignature(declaration)) &&
          own(declaration.getSourceFile())
        ) {
          // `factory(…).m()` or `const x = factory(…); x.m()`: only the
          // members that factory itself returns.
          let receiver = receiverExpression;
          if (receiver && ts.isIdentifier(receiver)) {
            const local = symbolOf(receiver)?.valueDeclaration;
            receiver =
              local && ts.isVariableDeclaration(local) && local.initializer
                ? local.initializer
                : undefined;
          }
          while (receiver && ts.isAwaitExpression(receiver))
            receiver = receiver.expression;
          const factory =
            receiver && ts.isCallExpression(receiver)
              ? (
                  symbolOf(
                    ts.isPropertyAccessExpression(receiver.expression)
                      ? receiver.expression.name
                      : receiver.expression,
                  )?.declarations ?? []
                )
                  .map((candidate) => target(candidate))
                  .find((candidate) => candidate !== null)
              : undefined;
          const inside = (member: ts.Node) => {
            for (let c: ts.Node | undefined = member; c; c = c.parent)
              if (c === factory) return true;
            return false;
          };
          const all = implementations(declaration);
          const narrowed = factory ? all.filter(inside) : [];
          const found = (narrowed.length ? narrowed : all)
            .map((member) =>
              ts.isShorthandPropertyAssignment(member)
                ? (checker.getShorthandAssignmentValueSymbol(member)
                    ?.valueDeclaration ?? null)
                : member,
            )
            .map((member) => (member ? target(member as ts.Declaration) : null))
            .filter((member): member is ts.Node => member !== null);
          // A property typed as an outside client (the postgres `sql` helper)
          // calls library code; only our own function types can hide SQL.
          const ownSignature =
            ts.isMethodSignature(declaration) ||
            checker
              .getTypeAtLocation(declaration)
              .getCallSignatures()
              .some((signature) => {
                const source = signature.getDeclaration()?.getSourceFile();
                return source ? own(source) : false;
              });
          if (!found.length && ownSignature) {
            const where = label(declaration);
            summary.unresolved.push(
              `${where.file} ${declaration.name.getText()}`,
            );
          }
          for (const next of found)
            summary.callees.push(
              stateOf(next, calleeEnv(next, call.arguments, env)),
            );
          continue;
        }
        const next = target(declaration);
        if (!next) continue;
        const pinned = call ? calleeEnv(next, call.arguments, env) : EMPTY;
        // A function declared inside this one closes over its pinned values.
        let enclosed = false;
        for (let c = next.parent; c && !enclosed; c = c.parent)
          enclosed = c === state.node;
        summary.callees.push(
          stateOf(next, enclosed ? new Map([...env, ...pinned]) : pinned),
        );
      }
    };

    const follow = (identifier: ts.Identifier) => {
      const named = identifier.parent as ts.Node & { name?: ts.Node };
      // A SQL tag (`tx\`…\``) is the client, not a function of ours.
      if (
        ts.isTaggedTemplateExpression(named) &&
        (named as ts.TaggedTemplateExpression).tag === identifier
      )
        return;
      // A declaration's own name is not a reference.
      if (
        named.name === identifier &&
        (ts.isBindingElement(named) ||
          ts.isVariableDeclaration(named) ||
          ts.isParameter(named) ||
          ts.isFunctionDeclaration(named) ||
          ts.isClassDeclaration(named) ||
          ts.isImportSpecifier(named))
      )
        return;
      let symbol = symbolOf(identifier);
      if (ts.isShorthandPropertyAssignment(identifier.parent))
        symbol =
          checker.getShorthandAssignmentValueSymbol(identifier.parent) ??
          symbol;
      if (!symbol?.declarations?.length) return;
      const parent = identifier.parent;
      let call: ts.CallExpression | undefined;
      if (ts.isCallExpression(parent) && parent.expression === identifier)
        call = parent;
      else if (
        ts.isPropertyAccessExpression(parent) &&
        parent.name === identifier &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent
      )
        call = parent.parent;
      // A function placed in an object literal runs when that property is
      // called, which property resolution follows; listing it calls nothing.
      let value: ts.Node = identifier;
      while (
        ts.isPropertyAccessExpression(value.parent) &&
        value.parent.name === value
      )
        value = value.parent;
      if (
        !call &&
        (ts.isShorthandPropertyAssignment(parent) ||
          (ts.isPropertyAssignment(value.parent) &&
            value.parent.initializer === value))
      )
        return;
      enter(
        symbol.declarations,
        call,
        ts.isPropertyAccessExpression(parent) ? parent.expression : undefined,
        parent,
      );
    };

    /** A span's text when it is a literal, pinned or `const` string. */
    const stringValue = (expression: ts.Expression): string | null => {
      const known = evaluate(expression, env);
      if (known && typeof known.value === 'string') return known.value;
      const declaration = ts.isIdentifier(expression)
        ? symbolOf(expression)?.valueDeclaration
        : undefined;
      return declaration &&
        ts.isVariableDeclaration(declaration) &&
        ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const &&
        declaration.initializer &&
        ts.isStringLiteralLike(declaration.initializer)
        ? declaration.initializer.text
        : null;
    };
    const statement = (node: ts.Statement): boolean => {
      // Nested function and class declarations run only when referenced.
      if (boundary(node)) return false;
      if (ts.isBlock(node)) return statements(node.statements);
      if (ts.isIfStatement(node)) {
        visit(node.expression);
        const condition = evaluate(node.expression, env);
        if (condition)
          return truthy(condition.value)
            ? statement(node.thenStatement)
            : node.elseStatement
              ? statement(node.elseStatement)
              : false;
        const then = statement(node.thenStatement);
        const otherwise = node.elseStatement
          ? statement(node.elseStatement)
          : false;
        return then && otherwise;
      }
      if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
        if (node.expression) visit(node.expression);
        return true;
      }
      if (ts.isSwitchStatement(node)) {
        visit(node.expression);
        const discriminant = evaluate(node.expression, env);
        const clauses = node.caseBlock.clauses;
        if (discriminant) {
          let start = clauses.findIndex(
            (clause) =>
              ts.isCaseClause(clause) &&
              evaluate(clause.expression, env)?.value === discriminant.value,
          );
          if (start < 0) start = clauses.findIndex(ts.isDefaultClause);
          if (start < 0) return false;
          // A top-level `break` always leaves the switch; one nested in a
          // branch only may, so the following clauses still run on fall-through.
          let mayLeave = false;
          for (const clause of clauses.slice(start)) {
            const flow = clauseFlow(clause.statements);
            if (flow === 'leave') return false;
            mayLeave ||= leavesSwitch(clause);
            if (flow === 'exit') return !mayLeave;
          }
          return false;
        }
        for (const clause of clauses) {
          if (ts.isCaseClause(clause)) visit(clause.expression);
          statements(clause.statements);
        }
        return false;
      }
      ts.forEachChild(node, visit);
      return false;
    };
    /** One clause in order: a return/throw, an unconditional break, or neither. */
    const clauseFlow = (
      list: readonly ts.Statement[],
    ): 'exit' | 'leave' | 'next' => {
      for (const node of list) {
        if (ts.isBreakStatement(node) || ts.isContinueStatement(node))
          return 'leave';
        if (ts.isBlock(node)) {
          const inner = clauseFlow(node.statements);
          if (inner !== 'next') return inner;
        } else if (statement(node)) return 'exit';
      }
      return 'next';
    };
    const leavesSwitch = (clause: ts.CaseOrDefaultClause) => {
      let found = false;
      const search = (current: ts.Node) => {
        if (found || functionLike(current) || ts.isClassLike(current)) return;
        if (ts.isBreakStatement(current) || ts.isContinueStatement(current)) {
          found = true;
          return;
        }
        // An inner loop or switch owns its own unlabeled break.
        if (
          ts.isIterationStatement(current, false) ||
          ts.isSwitchStatement(current)
        )
          return;
        ts.forEachChild(current, search);
      };
      clause.statements.forEach(search);
      return found;
    };
    const statements = (list: readonly ts.Statement[]) => {
      for (const node of list) if (statement(node)) return true;
      return false;
    };
    const visit = (node: ts.Node): void => {
      if (node !== state.node && boundary(node)) return;
      // `typeof f` and type arguments name functions without calling them.
      if (ts.isTypeNode(node)) return;
      if (ts.isConditionalExpression(node)) {
        visit(node.condition);
        const condition = evaluate(node.condition, env);
        if (!condition || truthy(condition.value)) visit(node.whenTrue);
        if (!condition || !truthy(condition.value)) visit(node.whenFalse);
        return;
      }
      if (ts.isBinaryExpression(node)) {
        const operator = node.operatorToken.kind;
        if (
          operator === ts.SyntaxKind.AmpersandAmpersandToken ||
          operator === ts.SyntaxKind.BarBarToken ||
          operator === ts.SyntaxKind.QuestionQuestionToken
        ) {
          visit(node.left);
          const left = evaluate(node.left, env);
          const skip =
            left &&
            (operator === ts.SyntaxKind.AmpersandAmpersandToken
              ? !truthy(left.value)
              : operator === ts.SyntaxKind.BarBarToken
                ? truthy(left.value)
                : left.value !== null && left.value !== undefined);
          if (!skip) visit(node.right);
          return;
        }
      }
      if (ts.isBlock(node) && node !== state.node) {
        statements(node.statements);
        return;
      }
      if (ts.isTaggedTemplateExpression(node) && own(node.getSourceFile())) {
        const text = sqlText(node);
        if (ROW_LOCK.test(text)) summary.locks.push(siteKey(node, text));
        if (SQL_WRITE.test(text)) summary.writes = true;
      }
      // `tx.unsafe('… for update')` or `tx['unsafe'](…)`: string SQL, checked
      // like a template. Interpolated text is SQL here, so a span that is not
      // a known string leaves the statement unresolved.
      const callee = ts.isCallExpression(node) ? node.expression : undefined;
      if (
        ts.isCallExpression(node) &&
        callee &&
        ((ts.isPropertyAccessExpression(callee) &&
          callee.name.text === 'unsafe') ||
          (ts.isElementAccessExpression(callee) &&
            ts.isStringLiteralLike(callee.argumentExpression) &&
            callee.argumentExpression.text === 'unsafe')) &&
        node.arguments[0] &&
        own(node.getSourceFile())
      ) {
        const argument = node.arguments[0];
        const spans = ts.isTemplateExpression(argument)
          ? argument.templateSpans.map((span) => stringValue(span.expression))
          : [];
        if (
          ts.isStringLiteral(argument) ||
          ts.isNoSubstitutionTemplateLiteral(argument) ||
          ts.isTemplateExpression(argument)
        ) {
          const text = ts.isTemplateExpression(argument)
            ? argument.head.text +
              argument.templateSpans
                .map(
                  (span, index) => (spans[index] ?? ' $ ') + span.literal.text,
                )
                .join('')
            : argument.text;
          if (ROW_LOCK.test(text)) summary.locks.push(siteKey(node, text));
          if (SQL_WRITE.test(text)) summary.writes = true;
        }
        if (
          !(
            ts.isStringLiteral(argument) ||
            ts.isNoSubstitutionTemplateLiteral(argument) ||
            ts.isTemplateExpression(argument)
          ) ||
          spans.some((span) => span === null)
        ) {
          const where = label(node);
          summary.unresolved.push(`${where.file} unsafe(<dynamic SQL>)`);
        }
      }
      // `helpers['read']()`: follow the literal key like a property access.
      if (
        ts.isElementAccessExpression(node) &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node
      ) {
        const key = node.argumentExpression;
        const property = ts.isStringLiteralLike(key)
          ? checker.getTypeAtLocation(node.expression).getProperty(key.text)
          : undefined;
        // `const services = { a: readA, b: () => … }; services[name]()`:
        // any member may run, so follow every one of them.
        const local = ts.isIdentifier(node.expression)
          ? symbolOf(node.expression)?.valueDeclaration
          : undefined;
        const members =
          !property &&
          local &&
          ts.isVariableDeclaration(local) &&
          local.initializer &&
          ts.isObjectLiteralExpression(local.initializer) &&
          local.initializer.properties.every(
            (member) =>
              ts.isShorthandPropertyAssignment(member) ||
              ts.isMethodDeclaration(member) ||
              (ts.isPropertyAssignment(member) &&
                (ts.isIdentifier(member.initializer) ||
                  ts.isPropertyAccessExpression(member.initializer) ||
                  functionLike(member.initializer))),
          )
            ? local.initializer.properties
            : undefined;
        if (property)
          enter(property.declarations ?? [], node.parent, node.expression);
        else if (members)
          enter(members as readonly ts.Declaration[], node.parent, undefined);
        else if (
          // A SQL client (`sql[name](…)` may be `unsafe`) or our own function.
          (!property &&
            !!checker
              .getTypeAtLocation(node.expression)
              .getProperty('unsafe')) ||
          checker
            .getTypeAtLocation(node)
            .getCallSignatures()
            .some((signature) => {
              const source = signature.getDeclaration()?.getSourceFile();
              return source ? own(source) : false;
            })
        ) {
          const where = label(node);
          summary.unresolved.push(`${where.file} [<dynamic key>]()`);
        }
      }
      if (ts.isIdentifier(node)) follow(node);
      ts.forEachChild(node, visit);
    };
    const node = state.node;
    if (functionLike(node)) {
      node.parameters.forEach(visit);
      if (node.body && ts.isBlock(node.body)) statements(node.body.statements);
      else if (node.body) visit(node.body);
    } else visit(node);
    return summary;
  }

  /** Breadth-first reach from one state; `onState` sees each state once. */
  function reach(
    start: State,
    onState: (state: State, summary: Summary, from: State | null) => void,
    stop: (state: State) => boolean = () => false,
  ) {
    const seen = new Set([start.key]);
    const queue: [State, State | null][] = [[start, null]];
    while (queue.length) {
      const [state, from] = queue.shift()!;
      const summary = summarize(state);
      onState(state, summary, from);
      for (const callee of summary.callees)
        if (!seen.has(callee.key)) {
          seen.add(callee.key);
          if (!stop(callee)) queue.push([callee, state]);
        }
    }
  }

  function routeEntries(methods: readonly RouteMethod[], only?: string) {
    const out: { route: string; state: State }[] = [];
    for (const path of routes) {
      const file = program.getSourceFile(path);
      const module = file && checker.getSymbolAtLocation(file);
      if (!module) continue;
      if (only && !relative(root, path).includes(only)) continue;
      for (const exported of checker.getExportsOfModule(module)) {
        if (!methods.includes(exported.name as RouteMethod)) continue;
        const symbol =
          exported.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(exported)
            : exported;
        for (const declaration of symbol.declarations ?? []) {
          const next = target(declaration);
          if (!next) continue;
          // Shared handlers branch on `request.method`; pin it per export.
          const request =
            functionLike(next) && next.parameters[0]
              ? next.parameters[0].name
              : undefined;
          out.push({
            route: `${relative(root, path)} ${exported.name}`,
            state: stateOf(
              next,
              request && ts.isIdentifier(request)
                ? new Map([[`${request.text}.method`, exported.name]])
                : EMPTY,
            ),
          });
        }
      }
    }
    return out;
  }

  function describe(state: State) {
    const where = label(state.node);
    const literals = [...state.env]
      .map(
        ([k, v]) => `${k}=${v === undefined ? 'undefined' : JSON.stringify(v)}`,
      )
      .join(', ');
    return `${where.file}:${where.line} ${where.name}${literals ? ` (${literals})` : ''}`;
  }

  /** `only` keeps route files whose path contains it (diagnostics). */
  function routeLocks(
    methods: readonly RouteMethod[],
    only?: string,
    barriers: readonly RouteBarrier[] = [],
  ): RouteLockReport {
    const entries = routeEntries(methods, only);
    const reached = new Map<string, { routes: Set<string>; chain: string[] }>();
    const unresolved = new Set<string>();
    const stopped = new Set<string>();
    for (const { route, state } of entries) {
      const parents = new Map<string, State | null>();
      const path = route.slice(0, route.lastIndexOf(' '));
      const stops = barriers.filter((barrier) => barrier.route === path);
      const stop = (callee: State) => {
        const where = label(callee.node);
        const hit = stops.find(
          (barrier) =>
            barrier.file === where.file && barrier.owner === where.name,
        );
        if (hit) stopped.add(`${hit.route} ${hit.file} ${hit.owner}`);
        return Boolean(hit);
      };
      reach(
        state,
        (current, summary, from) => {
          parents.set(current.key, from);
          for (const item of summary.unresolved) unresolved.add(item);
          for (const key of summary.locks) {
            let entry = reached.get(key);
            if (!entry) {
              const chain: string[] = [];
              for (
                let cursor: State | null | undefined = current;
                cursor;
                cursor = parents.get(cursor.key)
              )
                chain.unshift(describe(cursor));
              reached.set(key, (entry = { routes: new Set(), chain }));
            }
            entry.routes.add(route);
          }
        },
        stop,
      );
    }
    return {
      entries: entries.length,
      reached: [...reached]
        .map(([key, { routes: through, chain }]) => ({
          ...siteInfo.get(key)!,
          routes: [...through].sort(),
          chain,
        }))
        .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
      unresolved: [...unresolved].sort(),
      stopped: [...stopped].sort(),
    };
  }

  /** Every row-lock clause in the scanned sources, classified by its
   * transactions; `barriers` are the gate's reviewed writing calls. */
  function inventory(barriers: readonly RouteBarrier[] = []): InventorySite[] {
    const get = new Map(
      routeLocks(['GET'], undefined, barriers).reached.map((site) => [
        `${site.file}:${site.line}:${site.clause}`,
        site.routes.length,
      ]),
    );
    const write = new Map(
      routeLocks(WRITE_METHODS).reached.map((site) => [
        `${site.file}:${site.line}:${site.clause}`,
        site.routes.length,
      ]),
    );
    const all = new Set<string>();
    const bodies: ts.Node[] = [];
    for (const file of program.getSourceFiles()) {
      if (!own(file) || !sources.includes(file.fileName)) continue;
      const visit = (node: ts.Node) => {
        if (ts.isTaggedTemplateExpression(node)) {
          const text = sqlText(node);
          if (ROW_LOCK.test(text)) all.add(siteKey(node, text));
        }
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const opens =
            ts.isPropertyAccessExpression(callee) &&
            ['begin', 'savepoint'].includes(callee.name.text);
          for (const arg of node.arguments) {
            const first =
              functionLike(arg) && arg.parameters[0]
                ? arg.parameters[0]
                : undefined;
            const typed =
              first &&
              (/TransactionSql|\bTx\b|Transaction\b/.test(
                checker.typeToString(checker.getTypeAtLocation(first)),
              ) ||
                (ts.isIdentifier(first.name) && SQL_TAG.test(first.name.text)));
            if (functionLike(arg) && (opens || typed)) bodies.push(arg);
            else if (opens && ts.isIdentifier(arg))
              for (const declaration of symbolOf(arg)?.declarations ?? []) {
                const next = target(declaration);
                if (next) bodies.push(next);
              }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    const reads = new Map<string, number>();
    const writes = new Map<string, number>();
    for (const body of bodies) {
      const locks = new Set<string>();
      let writing = false;
      reach(stateOf(body, EMPTY), (_state, summary) => {
        for (const key of summary.locks) locks.add(key);
        writing ||= summary.writes;
      });
      for (const key of locks) {
        const counter = writing ? writes : reads;
        counter.set(key, (counter.get(key) ?? 0) + 1);
      }
    }
    return [...all]
      .map((key): InventorySite => {
        const readTransactions = reads.get(key) ?? 0;
        const writeTransactions = writes.get(key) ?? 0;
        return {
          ...siteInfo.get(key)!,
          getRoutes: get.get(key) ?? 0,
          writeRoutes: write.get(key) ?? 0,
          readTransactions,
          writeTransactions,
          category: get.has(key)
            ? 'get_path'
            : writeTransactions
              ? 'write_transaction'
              : readTransactions
                ? 'read_transaction'
                : 'no_transaction',
        };
      })
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  return { routeLocks, inventory };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const inventoryMode = process.argv.includes('--inventory');
  const audit = createRowLockAudit(process.cwd(), {
    inventory: inventoryMode,
  });
  // Same barriers as the gate unless `--raw` asks for every reachable lock.
  const { writingGetCalls } = await import('./row-lock-audit.allowlist.ts');
  const barriers = process.argv.includes('--raw') ? [] : writingGetCalls;
  if (inventoryMode) {
    console.log(JSON.stringify(audit.inventory(barriers), null, 2));
  } else {
    const methods = (
      process.argv[2]?.startsWith('--')
        ? ['GET']
        : (process.argv[2]?.split(',') ?? ['GET'])
    ) as RouteMethod[];
    const only = process.argv.includes('--route')
      ? process.argv[process.argv.indexOf('--route') + 1]
      : undefined;
    const report = audit.routeLocks(methods, only, barriers);
    if (process.argv.includes('--json'))
      console.log(JSON.stringify(report, null, 2));
    else {
      for (const site of report.reached) {
        console.log(
          `${site.file}:${site.line}\t${site.clause}\t${site.owner}\t${site.routes.length} route(s)`,
        );
        if (process.argv.includes('--chain'))
          console.log(`    ${site.chain.join('\n    -> ')}`);
      }
      console.error(
        `entries=${report.entries} lockSites=${report.reached.length} unresolved=${report.unresolved.length}`,
      );
    }
  }
}
