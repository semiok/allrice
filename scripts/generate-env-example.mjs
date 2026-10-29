import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from 'yaml';

const access = (n) =>
  ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n);
const property = (n) =>
  ts.isPropertyAccessExpression(n)
    ? n.name.text
    : ts.isStringLiteralLike(n.argumentExpression)
      ? n.argumentExpression.text
      : undefined;
const processModule = (n) =>
  n && ts.isStringLiteralLike(n) && /^(node:)?process$/.test(n.text);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const keyPattern = /^[A-Z][A-Z0-9_]*$/;

export function generateExample(
  root,
  policy = parse(
    readFileSync(join(root, 'scripts/env-example-policy.yml'), 'utf8'),
  ),
) {
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--', 'apps', 'packages', 'scripts/dev-environment.mjs'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(
      (f) =>
        /\.[cm]?[jt]sx?$/.test(f) &&
        !/(?:\.(?:test|spec|fixture)\.|\/(?:test|tests|fixtures)\/|[-.]fixture\.[cm]?[jt]s$)/.test(
          f,
        ) &&
        !f.startsWith('apps/worker/dsh/'),
    );
  const names = new Set(),
    audits = new Map(),
    found = new Set();
  for (const file of files) {
    const path = join(root, file);
    const program = ts.createProgram([path], {
      noResolve: true,
      noLib: true,
      allowJs: true,
      types: [],
    });
    const ast = program.getSourceFile(path),
      checker = program.getTypeChecker();
    if (ast.parseDiagnostics.length) throw Error(`Cannot parse ${file}`);
    const symbol = (n) =>
      ts.isShorthandPropertyAssignment(n.parent)
        ? checker.getShorthandAssignmentValueSymbol(n.parent)
        : ts.isExportSpecifier(n.parent)
          ? checker.getExportSpecifierLocalTargetSymbol(n.parent)
          : checker.getSymbolAtLocation(n);
    const declarationName = (n) =>
      n.parent.name === n &&
      !ts.isShorthandPropertyAssignment(n.parent) &&
      !ts.isExportSpecifier(n.parent);
    const global = (n, name) =>
      ts.isIdentifier(n) && n.text === name && !symbol(n)?.declarations?.length;
    const processObject = (n) =>
      global(n, 'process') ||
      (ts.isIdentifier(n) &&
        symbol(n)?.declarations?.some(
          (d) =>
            ts.isImportClause(d) && processModule(d.parent.moduleSpecifier),
        )) ||
      (access(n) &&
        property(n) === 'process' &&
        global(n.expression, 'globalThis'));
    const direct = (n) =>
      n && access(n) && processObject(n.expression) && property(n) === 'env';
    const seed = (n) =>
      direct(n) ||
      (n &&
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        direct(n.left) &&
        ts.isObjectLiteralExpression(n.right) &&
        !n.right.properties.length);
    const environment = (n) =>
      direct(n) ||
      (ts.isIdentifier(n) &&
        symbol(n)?.declarations?.some(
          (d) =>
            (ts.isVariableDeclaration(d) || ts.isParameter(d)) &&
            (seed(d.initializer) ||
              /^(?:NodeJS\.)?ProcessEnv$/.test(d.type?.getText(ast) ?? '')),
        ));
    const helperIndex = (n) => {
      const d = ts.isIdentifier(n) && symbol(n)?.declarations?.[0];
      if (
        !d ||
        !(
          ts.isFunctionDeclaration(d) ||
          ts.isVariableDeclaration(d) ||
          ts.isImportSpecifier(d)
        )
      )
        return;
      const name = (
        ts.isImportSpecifier(d) ? (d.propertyName ?? d.name) : d.name
      )?.getText(ast);
      const index =
        policy.calls[`${file}#${name}`] ?? policy.calls[`*#${name}`];
      if (index !== undefined && ts.isImportSpecifier(d) && d.propertyName)
        throw Error(`Unsupported helper import alias: ${file}#${name}`);
      return index;
    };
    const add = (name) => {
      if (!keyPattern.test(name))
        throw Error(`Invalid environment name in ${file}`);
      names.add(name);
    };
    const audit = (kind) => {
      const id = `${file}#${kind}`;
      if (!policy.audit[id]) throw Error(`Unaudited environment access: ${id}`);
      if (policy.auditSources[file] !== sha256(readFileSync(path)))
        throw Error(`Stale source audit: ${file}`);
      found.add(file);
      found.add(id);
      audits.set(id, (audits.get(id) ?? 0) + 1);
    };
    // Only literal data in selected existing declarations; no expression evaluation.
    const definition = (n) => {
      if (ts.isStringLiteralLike(n)) {
        if (/^ALLRICE_[A-Z0-9_]+$/.test(n.text)) add(n.text);
      } else if (ts.isAsExpression(n)) definition(n.expression);
      else if (ts.isArrayLiteralExpression(n)) n.elements.forEach(definition);
      else if (ts.isObjectLiteralExpression(n))
        n.properties.forEach((p) => {
          if (!ts.isPropertyAssignment(p))
            throw Error(`Non-literal declaration in ${file}`);
          definition(p.initializer);
        });
      else if (!ts.isNumericLiteral(n))
        throw Error(`Non-literal declaration in ${file}`);
    };
    const visit = (n) => {
      if (
        (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
        processModule(n.moduleSpecifier)
      ) {
        const bindings = n.importClause?.namedBindings;
        if (
          ts.isExportDeclaration(n) ||
          (bindings &&
            (ts.isNamespaceImport(bindings) ||
              bindings.elements.some((entry) =>
                ['env', 'default'].includes(
                  (entry.propertyName ?? entry.name).text,
                ),
              )))
        )
          throw Error(`Unsupported process import: ${file}`);
      }
      if (
        ts.isCallExpression(n) &&
        processModule(n.arguments[0]) &&
        (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
      )
        throw Error(`Unsupported dynamic process import: ${file}`);
      if (
        ts.isIdentifier(n) &&
        helperIndex(n) !== undefined &&
        !declarationName(n) &&
        !(ts.isCallExpression(n.parent) && n.parent.expression === n)
      )
        throw Error(`Unsupported helper escape: ${file}#${n.text}`);

      if (
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        !seed(n.initializer) &&
        (environment(n.initializer) || processObject(n.initializer))
      )
        audit('alias');
      if (access(n) && environment(n.expression)) {
        const name = property(n);
        if (name !== undefined) add(name);
        else audit(n.getText(ast));
      }
      if (
        (ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n)) &&
        n.name
      ) {
        const id = `${file}#${n.name.getText(ast)}`;
        if (policy.definitions.includes(id)) {
          definition(n.initializer);
          found.add(id);
        }
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const id = `${file}#${n.expression.text}`,
          index = helperIndex(n.expression);
        if (index !== undefined) {
          const argument = n.arguments[index];
          if (!argument || !ts.isStringLiteralLike(argument))
            throw Error(`Non-literal environment argument: ${id}`);
          add(argument.text);
          found.add(
            Object.hasOwn(policy.calls, id) ? id : `*#${n.expression.text}`,
          );
        }
      }
      if (
        environment(n) &&
        !(access(n.parent) && n.parent.expression === n) &&
        !(ts.isIdentifier(n) && declarationName(n))
      ) {
        const value =
          ts.isBinaryExpression(n.parent) && seed(n.parent) ? n.parent : n;
        if (!(
          (ts.isVariableDeclaration(value.parent) ||
            ts.isParameter(value.parent)) &&
          ts.isIdentifier(value.parent.name) &&
          value.parent.initializer === value
        ))
          audit('whole');
      }
      if (
        (ts.isStringLiteralLike(n) && /\bprocess\.env\b/.test(n.text)) ||
        (ts.isTemplateExpression(n) &&
          [n.head, ...n.templateSpans.map((s) => s.literal)].some((p) =>
            /\bprocess\.env\b/.test(p.text),
          ))
      )
        audit('embedded');
      ts.forEachChild(n, visit);
    };
    visit(ast);
  }
  for (const id of [
    ...policy.definitions,
    ...Object.keys(policy.calls),
    ...Object.keys(policy.audit),
    ...Object.keys(policy.auditSources),
  ])
    if (!found.has(id)) throw Error(`Stale environment metadata: ${id}`);
  const omitted = new Set();
  for (const [pattern, reason] of Object.entries(policy.exclude)) {
    const matching = [...names].filter((name) =>
      new RegExp(pattern).test(name),
    );
    if (!reason || !matching.length)
      throw Error(`Stale environment exclusion: ${pattern}`);
    matching.forEach((name) => omitted.add(name));
  }
  const published = [...names].filter((name) => !omitted.has(name)).sort();
  for (const [name, value] of Object.entries(policy.examples))
    if (
      !published.includes(name) ||
      typeof value !== 'string' ||
      /[\r\n]/.test(value)
    )
      throw Error(`Invalid/stale safe example: ${name}`);
  const lines = [
    '# Generated by pnpm env:generate; verify with pnpm env:check. Do not edit.',
    '# Names: tracked apps/packages TS/JS + scripts/dev-environment.mjs, finite AST only.',
    '# Excludes tests/fixtures, Worker dsh child payloads and other development tooling.',
    '# Other settings are unset, not necessarily optional: DATABASE_URL is required except for pnpm dev local DB setup.',
    '# Supply credentials/secrets when enabling their features; prepare/review ALLRICE_DSH_NATIVE_ARTIFACT_ID before pnpm dev.',
    '',
    ...Object.entries(policy.examples).map(
      ([name, value]) => `${name}=${value}`,
    ),
    '',
    ...published
      .filter((name) => !Object.hasOwn(policy.examples, name))
      .map((name) => `# ${name}=`),
    '',
    '# Opaque reads/exclusions are outside complete coverage; see scripts/env-example-policy.yml.',
    `# Audit inventory SHA256: ${sha256(JSON.stringify([[...audits], policy.auditSources, policy.audit]))}`,
  ];
  return {
    text: lines.join('\n') + '\n',
    files: files.length,
    names: names.size,
    published: published.length,
    omitted: omitted.size,
    audits: Object.fromEntries(audits),
  };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const check = process.argv[2] === '--check';
  if (process.argv.length > (check ? 3 : 2))
    throw Error('Usage: generate-env-example.mjs [--check]');
  const result = generateExample(process.cwd()),
    target = join(process.cwd(), '.env.example');
  if (check) {
    if (readFileSync(target, 'utf8') !== result.text)
      throw Error('.env.example drift: run pnpm env:generate');
  } else writeFileSync(target, result.text);
  console.log(JSON.stringify({ ...result, text: undefined }));
}
