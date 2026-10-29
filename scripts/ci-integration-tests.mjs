import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from 'yaml';

const automatic = {
  ALLRICE_RUN_DB_INTEGRATION: 'db',
  ALLRICE_RUN_BROWSER_INTEGRATION: 'browser',
  ALLRICE_RUN_BRAND_CONTENT_BROWSER: 'browser',
  ALLRICE_TEST_STATIC_BROWSER: 'browser',
  ALLRICE_WORKBENCH_BROWSER_TEST: 'browser',
  ALLRICE_NATIVE_ONCE_PROBE_MODULE_BASE: 'db',
  ALLRICE_P11_NEXT_BUILD: 'build',
};
const unique = (values) => [...new Set(values)].sort();
const read = (path) => readFileSync(path, 'utf8');
const tokens = (command) =>
  command.match(/(?:apps|packages|tests|scripts)\/[\w./-]+/g) ?? [];
const matches = (file, filters) =>
  filters.some(
    (filter) => file === filter.split(':')[0] || file.startsWith(filter + '/'),
  );
const enabled = (gates, env) =>
  gates.every((gate) =>
    automatic[gate] && gate !== 'ALLRICE_NATIVE_ONCE_PROBE_MODULE_BASE'
      ? String(env[gate]) === '1'
      : !!env[gate] && String(env[gate]) !== '0',
  );
const sameSite = (item, test) =>
  item.line === test.location?.line && item.column === test.location?.column;

// Read registration conditions, including suite aliases; do not confuse fixture
// environment writes or child-process strings with switches that skip tests.
export function registrations(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const checker = ts
    .createProgram(
      [file],
      { noResolve: true, noLib: true, allowJs: true },
      {
        ...ts.createCompilerHost({}),
        getSourceFile: (name) => (name === file ? ast : undefined),
      },
    )
    .getTypeChecker();
  const declaration = (node) =>
    checker.getSymbolAtLocation(node)?.declarations?.[0];
  const binding = (node) => declaration(node)?.initializer;
  const errors = [];
  const unsupported = (node) => {
    errors.push(
      `Unsupported registration: ${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${node.getText(ast).slice(0, 100)}`,
    );
    switches.push(...environment(node));
  };
  function environment(node, seen = new Set()) {
    if (!node) return [];
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText(ast) === 'process.env'
    )
      return [node.name.text];
    if (ts.isIdentifier(node) && binding(node) && !seen.has(node.text))
      return environment(binding(node), new Set([...seen, node.text]));
    const result = [];
    ts.forEachChild(node, (child) => {
      result.push(...environment(child, seen));
    });
    return unique(result);
  }
  function callee(node, seen = new Set()) {
    if (ts.isParenthesizedExpression(node))
      return callee(node.expression, seen);
    if (ts.isIdentifier(node)) {
      if (binding(node) && !seen.has(node.text))
        return callee(binding(node), new Set([...seen, node.text]));
      const declared = declaration(node);
      const name =
        declared &&
        ts.isImportSpecifier(declared) &&
        declared.parent.parent.parent.moduleSpecifier.text === 'vitest'
          ? (declared.propertyName ?? declared.name).text
          : !declared
            ? node.text
            : null;
      if (['describe', 'it', 'test'].includes(name))
        return { kind: name, gates: [] };
    }
    if (
      ts.isElementAccessExpression(node) ||
      ts.isTaggedTemplateExpression(node)
    ) {
      if (callee(node.expression ?? node.tag, seen)) unsupported(node.parent);
      return null;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = callee(node.expression, seen);
      if (
        base &&
        !['sequential', 'concurrent', 'only', 'skip', 'todo', 'fails'].includes(
          node.name.text,
        )
      )
        unsupported(node);
      return base;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'each'
    ) {
      const base = callee(node.expression.expression, seen);
      return base;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['skipIf', 'runIf'].includes(node.expression.name.text)
    ) {
      const base = callee(node.expression.expression, seen);
      if (base) {
        const gates = environment(node.arguments[0]);
        if (!gates.length) unsupported(node);
        return { ...base, gates: unique([...base.gates, ...gates]) };
      }
    }
    if (ts.isConditionalExpression(node)) {
      const base = callee(node.whenTrue, seen) ?? callee(node.whenFalse, seen);
      if (base)
        return {
          ...base,
          gates: unique([...base.gates, ...environment(node.condition)]),
        };
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.some((arg) => callee(arg, seen))
    )
      unsupported(node);
    return null;
  }
  const cases = [],
    switches = [];
  function visit(node, gates = [], ancestors = [], blocked = null) {
    if (
      ts.isNamespaceImport(node) &&
      node.parent.parent.moduleSpecifier.text === 'vitest'
    )
      throw Error(
        `Unsupported registration: ${file}: use named Vitest imports`,
      );
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ['each', 'skipIf', 'runIf'].includes(node.expression.name.text)
      )
        return;
      const registration = callee(node.expression);
      if (registration) {
        switches.push(...registration.gates);
        if (blocked || !node.arguments[0]) unsupported(blocked ?? node);
        if (!node.arguments[0]) return;
        const title = ts.isStringLiteralLike(node.arguments[0])
          ? node.arguments[0].text
          : node.arguments[0]?.getText(ast);
        const inherited = unique([...gates, ...registration.gates]);
        if (registration.kind === 'describe') {
          const callback = node.arguments.find(
            (arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
          );
          if (!callback) unsupported(node);
          else visit(callback.body, inherited, [...ancestors, title]);
        } else {
          const expression = node.expression;
          const position = ts.isParenthesizedExpression(expression)
            ? expression.end - 1
            : ts.isCallExpression(expression)
              ? expression.end
              : ts.isPropertyAccessExpression(expression)
                ? expression.name.getStart(ast)
                : expression.getStart(ast);
          const location = ast.getLineAndCharacterOfPosition(position);
          cases.push({
            title,
            ancestors,
            gates: inherited,
            line: location.line + 1,
            column: location.character + 1,
          });
        }
        return; // Test bodies are not registration scope.
      }
    }
    const conditional =
      ts.isIfStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isConditionalExpression(node) ||
      ts.isFunctionLike(node) ||
      (ts.isBinaryExpression(node) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(node.operatorToken.kind));
    ts.forEachChild(node, (child) =>
      visit(child, gates, ancestors, blocked || (conditional ? node : null)),
    );
  }
  visit(ast);
  return {
    gates:
      cases[0]?.gates.filter((gate) =>
        cases.every((item) => item.gates.includes(gate)),
      ) ?? [],
    cases,
    errors,
    switches: unique(switches),
  };
}

export function inventory(root = process.cwd()) {
  const manual = parse(
    read(resolve(root, 'scripts/ci-manual-environments.yml')),
  );
  const workflow = parse(read(resolve(root, '.github/workflows/ci.yml')));
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file));
  const steps = Object.entries(workflow.jobs).flatMap(([job, value]) =>
    value.steps
      .filter((step) =>
        /(?:vitest run|pnpm test|ci-integration-tests\.mjs run)/.test(
          step.run ?? '',
        ),
      )
      .map((step) => ({
        job,
        name: step.name,
        run: step.run,
        env: {
          ...workflow.env,
          ...value.env,
          ...step.env,
          ...Object.fromEntries(
            [...step.run.matchAll(/\b(ALLRICE_\w+)=([^\s]+)/g)].map((match) => [
              match[1],
              match[2],
            ]),
          ),
        },
      })),
  );
  function classify(gates) {
    for (const gate of gates)
      if (!automatic[gate] && !manual[gate])
        throw Error(`Unclassified test gate: ${gate}`);
      else if (
        manual[gate] &&
        (!manual[gate].reason || !manual[gate].command?.includes('{file}'))
      )
        throw Error(`Manual gate needs a reason and runnable entry: ${gate}`);
    return gates.some((gate) => manual[gate])
      ? 'manual'
      : unique(gates.map((gate) => automatic[gate]))
          .filter(Boolean)
          .join('+') || 'native';
  }
  const manualCommand = (file, gates) => {
    const assignments = unique(
      gates.flatMap((gate) =>
        manual[gate]
          ? manual[gate].command.split(' pnpm exec vitest run ')[0].split(' ')
          : [
              `${gate}=${gate === 'ALLRICE_NATIVE_ONCE_PROBE_MODULE_BASE' ? '"$PWD/apps/worker/package.json"' : '1'}`,
            ],
      ),
    );
    return `${assignments.join(' ')} pnpm exec vitest run ${file} --maxWorkers=2`;
  };
  const covered = (file, gates, title) =>
    steps.filter((step) => {
      const pattern = step.run.match(/(?:^|\s)-t\s+(['"])(.*?)\1/);
      return (
        enabled(gates, step.env) &&
        (!pattern || (title && new RegExp(pattern[2]).test(title))) &&
        (/\bpnpm test\b/.test(step.run) || matches(file, tokens(step.run)))
      );
    });
  const entries = unique(files).flatMap((file) => {
    const registration = registrations(file, read(resolve(root, file)));
    if (
      !/\.(integration|browser)\.test\./.test(file) &&
      !registration.switches.some((gate) => automatic[gate] || manual[gate])
    )
      return [];
    if (registration.errors.length) throw Error(registration.errors.join('\n'));
    classify(registration.switches);
    const group = classify(registration.gates);
    return [
      {
        file,
        group,
        gates: registration.gates,
        coveredBy: covered(file, registration.gates).map(
          (step) => `${step.job}: ${step.name ?? step.run}`,
        ),
        cases: registration.cases.map((item) => ({
          ...item,
          group: classify(item.gates),
          coveredBy: covered(file, item.gates, item.title).map(
            (step) => step.job,
          ),
        })),
        manual: Object.fromEntries(
          unique(registration.cases.flatMap((item) => item.gates))
            .filter((gate) => manual[gate])
            .map((gate) => [
              gate,
              {
                ...manual[gate],
                command: manual[gate].command.replace('{file}', file),
              },
            ]),
        ),
        manualCommands: (group === 'manual'
          ? [{ gates: registration.gates }]
          : registration.cases.filter(
              (item) => classify(item.gates) === 'manual',
            )
        ).map((item) => ({
          title: item.title ?? null,
          command: manualCommand(file, item.gates),
        })),
      },
    ];
  });
  const additions = { db: [], browser: [], 'browser+db': [] };
  for (const entry of entries) {
    if (entry.group === 'manual') continue;
    if (!entry.coveredBy.length) {
      if (!additions[entry.group])
        throw Error(`No automatic runner: ${entry.file} (${entry.group})`);
      additions[entry.group].push({ file: entry.file, gates: entry.gates });
    }
    for (const item of entry.cases) {
      if (
        item.group === 'manual' ||
        item.coveredBy.length ||
        (entry.group === item.group && !entry.coveredBy.length)
      )
        continue;
      if (!additions[item.group])
        throw Error(`No automatic case runner: ${entry.file}: ${item.title}`);
      additions[item.group].push({
        file: entry.file,
        title: item.title,
        line: item.line,
        column: item.column,
        gates: item.gates,
      });
    }
  }
  for (const [group, items] of Object.entries(additions)) {
    const step = steps.find((step) =>
      step.run.includes(`ci-integration-tests.mjs run ${group}`),
    );
    if (!step) throw Error(`Missing CI collection step: ${group}`);
    for (const item of items) {
      if (!enabled(item.gates, step.env))
        throw Error(
          `Collection step disables ${item.file}: ${item.gates.join(',')}`,
        );
    }
  }
  return {
    head: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    entries,
    additions,
    steps,
  };
}

export function audit(
  entries,
  report,
  filters,
  env,
  pattern,
  root = process.cwd(),
) {
  const result = [];
  for (const entry of entries.filter(
    (entry) => entry.group !== 'manual' && matches(entry.file, filters),
  )) {
    const suite = report.testResults.find(
      (suite) =>
        relative(root, suite.name).replaceAll('\\', '/') === entry.file,
    );
    if (!suite?.assertionResults.length)
      throw Error(`Not collected: ${entry.file}`);
    for (const item of entry.cases)
      if (!suite.assertionResults.some((test) => sameSite(item, test)))
        throw Error(
          `Missing registered test: ${entry.file}:${item.line}:${item.column} ${item.title}`,
        );
    if (!enabled(entry.gates, env)) {
      if (filters.includes(entry.file) || !entry.coveredBy?.length)
        throw Error(`Explicit suite gate is disabled: ${entry.file}`);
      if (
        suite.assertionResults.some(
          (test) => !['pending', 'skipped'].includes(test.status),
        )
      )
        throw Error(`Disabled suite unexpectedly ran: ${entry.file}`);
      result.push({
        file: entry.file,
        passed: 0,
        deferred: [{ group: entry.group, gates: entry.gates }],
      });
      continue;
    }
    let passed = 0;
    const deferred = [];
    for (const test of suite.assertionResults) {
      if (pattern && !new RegExp(pattern).test(test.fullName)) continue;
      const lines = filters
        .filter((filter) => filter.startsWith(entry.file + ':'))
        .map((filter) => Number(filter.split(':').at(-1)));
      if (lines.length && !lines.includes(test.location?.line)) continue;
      const condition = entry.cases.find((item) => sameSite(item, test));
      if (!condition)
        throw Error(
          `Unclassified registered test: ${entry.file}: ${test.fullName}`,
        );
      if (test.status === 'passed') {
        if (!enabled(condition.gates, env))
          throw Error(
            `Disabled case unexpectedly ran: ${entry.file}: ${test.fullName}`,
          );
        passed++;
        continue;
      }
      if (
        ['pending', 'skipped'].includes(test.status) &&
        condition &&
        !enabled(condition.gates, env)
      ) {
        deferred.push({
          title: test.title,
          group: condition.group,
          gates: condition.gates,
        });
      } else
        throw Error(
          `Unexpected ${test.status}: ${entry.file}: ${test.fullName}`,
        );
    }
    if (!passed) throw Error(`No executed passing tests: ${entry.file}`);
    result.push({ file: entry.file, passed, deferred });
  }
  return result;
}

function main() {
  const [action, ...args] = process.argv.slice(2);
  const plan = inventory();
  if (action === 'inventory') {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (action === 'audit-native') {
    const entries = plan.entries.filter((entry) => entry.group === 'native');
    console.log(
      JSON.stringify(
        audit(
          entries,
          JSON.parse(read(args[0])),
          entries.map((entry) => entry.file),
          process.env,
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (action !== 'run')
    throw Error(
      'Use inventory or run [db|browser|browser+db] -- [Vitest arguments]',
    );
  const group = args[0] === '--' ? null : args.shift();
  if (args[0] !== '--') throw Error('Vitest arguments must follow --');
  const vitest = args.slice(1);
  if (group) {
    const items = plan.additions[group];
    if (!items) throw Error(`Unknown group: ${group}`);
    if (!items.length) {
      console.log(`No additional ${group} files`);
      return;
    }
    // Whole suites and conditional cases have different filters; never run an
    // entire DB suite with browser switches just to enable one browser case.
    for (const item of items) {
      if (!enabled(item.gates, process.env))
        throw Error(`Automatic runner gate is disabled: ${item.file}`);
    }
    const batches = [];
    for (const batch of ['whole', 'cases']) {
      const selected = items.filter(
        (item) => !!item.line === (batch === 'cases'),
      );
      if (!selected.length) continue;
      const args = vitest.map((arg) =>
        arg.startsWith('--outputFile=')
          ? arg.replace(/(?:\.json)?$/, `-${batch}.json`)
          : arg,
      );
      batches.push(
        run(plan, [
          ...args,
          ...unique(
            selected.map(
              (item) => item.file + (item.line ? `:${item.line}` : ''),
            ),
          ),
        ]),
      );
    }
    const output =
      vitest
        .find((arg) => arg.startsWith('--outputFile='))
        ?.slice('--outputFile='.length) ??
      `.local/integration-collection/${group}`;
    writeFileSync(
      `${output}.summary.json`,
      JSON.stringify({ head: plan.head, group, batches }, null, 2) + '\n',
    );
  } else run(plan, vitest);
}
function run(plan, args) {
  const filters = args.flatMap(
    (arg) =>
      arg.match(/(?:apps|packages|tests|scripts)\/[\w./-]+(?::\d+)?/g) ?? [],
  );
  if (!filters.length)
    throw Error('Explicit test files or directories required');
  const supplied = args.find((arg) => arg.startsWith('--outputFile='));
  const report =
    supplied?.slice('--outputFile='.length) ??
    `.local/integration-collection/${createHash('sha256').update(args.join('\0')).digest('hex').slice(0, 12)}.json`;
  mkdirSync(dirname(report), { recursive: true });
  const command = [
    ...args,
    ...(!supplied
      ? ['--reporter=default', '--reporter=json', `--outputFile=${report}`]
      : []),
  ];
  const child = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', '--includeTaskLocation', ...command],
    {
      stdio: 'inherit',
    },
  );
  const receipt = { head: plan.head, args, exitCode: child.status ?? 1 };
  try {
    if (child.error || child.status !== 0)
      throw child.error ?? Error(`Vitest exit ${child.status}`);
    const patternIndex = args.findIndex((arg) =>
      ['-t', '--testNamePattern'].includes(arg),
    );
    receipt.evidence = audit(
      plan.entries,
      JSON.parse(read(report)),
      filters,
      process.env,
      patternIndex >= 0 ? args[patternIndex + 1] : undefined,
    );
  } catch (error) {
    receipt.error = error.message;
    process.exitCode = receipt.exitCode = child.status || 1;
    console.error(receipt.error);
  }
  writeFileSync(
    `${report}.collection.json`,
    JSON.stringify(receipt, null, 2) + '\n',
  );
  const evidence = receipt.evidence ?? [];
  if (receipt.evidence)
    console.log(
      `Verified collection: ${evidence.length} files; ${evidence.reduce((total, item) => total + item.passed, 0)} passed assertions; ${evidence.reduce((total, item) => total + item.deferred.length, 0)} explicitly deferred assertions (not passes)`,
    );
  return {
    report,
    collection: `${report}.collection.json`,
    exitCode: receipt.exitCode,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
