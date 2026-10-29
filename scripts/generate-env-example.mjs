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
const processObject = (n) =>
  (ts.isIdentifier(n) && n.text === 'process') ||
  (access(n) &&
    property(n) === 'process' &&
    n.expression.getText() === 'globalThis');
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
    const environment = (n) =>
      direct(n) ||
      (ts.isIdentifier(n) &&
        checker
          .getSymbolAtLocation(n)
          ?.declarations?.some(
            (d) =>
              seed(d.initializer) ||
              /^(?:NodeJS\.)?ProcessEnv$/.test(d.type?.getText(ast) ?? ''),
          ));
    const add = (name) => {
      if (!keyPattern.test(name))
        throw Error(`Invalid environment name in ${file}`);
      names.add(name);
    };
    const audit = (kind) => {
      const id = `${file}#${kind}`;
      if (!policy.audit[id]) throw Error(`Unaudited environment access: ${id}`);
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
          index = policy.calls[id] ?? policy.calls[`*#${n.expression.text}`];
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
      if (direct(n) && !(access(n.parent) && n.parent.expression === n)) {
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
    `# Audit inventory SHA256: ${createHash('sha256')
      .update(JSON.stringify([...audits]))
      .digest('hex')}`,
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
