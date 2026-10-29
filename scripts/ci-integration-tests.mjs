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
  filters.some((filter) => file === filter || file.startsWith(filter + '/'));

// Read registration conditions, including suite aliases; do not confuse fixture
// environment writes or child-process strings with switches that skip tests.
export function registrations(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const variables = new Map();
  function variablesIn(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    )
      variables.set(node.name.text, node.initializer);
    ts.forEachChild(node, variablesIn);
  }
  variablesIn(ast);
  function environment(node, seen = new Set()) {
    if (!node) return [];
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText(ast) === 'process.env'
    )
      return [node.name.text];
    if (
      ts.isIdentifier(node) &&
      variables.has(node.text) &&
      !seen.has(node.text)
    )
      return environment(
        variables.get(node.text),
        new Set([...seen, node.text]),
      );
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
      if (['describe', 'it', 'test'].includes(node.text))
        return { kind: node.text, gates: [] };
      if (variables.has(node.text) && !seen.has(node.text))
        return callee(variables.get(node.text), new Set([...seen, node.text]));
    }
    if (ts.isPropertyAccessExpression(node))
      return callee(node.expression, seen);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['skipIf', 'runIf'].includes(node.expression.name.text)
    ) {
      const base = callee(node.expression.expression, seen);
      if (base)
        return {
          ...base,
          gates: unique([...base.gates, ...environment(node.arguments[0])]),
        };
    }
    if (ts.isConditionalExpression(node)) {
      const base = callee(node.whenTrue, seen) ?? callee(node.whenFalse, seen);
      if (base)
        return {
          ...base,
          gates: unique([...base.gates, ...environment(node.condition)]),
        };
    }
    return null;
  }
  const suites = [],
    cases = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const registration = callee(node.expression);
      if (registration) {
        if (registration.kind === 'describe')
          suites.push(...registration.gates);
        else
          cases.push({
            title: node.arguments[0].text,
            gates: registration.gates,
          });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const common = cases.length
    ? cases[0].gates.filter((gate) =>
        cases.every((item) => item.gates.includes(gate)),
      )
    : [];
  return {
    gates: unique([...suites, ...common]),
    cases: cases.filter((item) => item.gates.length),
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
  const enabled = (gates, env) =>
    gates.every((gate) =>
      gate === 'ALLRICE_NATIVE_ONCE_PROBE_MODULE_BASE'
        ? !!env[gate]
        : String(env[gate]) === '1',
    );
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
      !registration.gates.some((gate) => automatic[gate])
    )
      return [];
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
          group: classify(unique([...registration.gates, ...item.gates])),
          coveredBy: covered(
            file,
            unique([...registration.gates, ...item.gates]),
            item.title,
          ).map((step) => step.job),
        })),
        manual: Object.fromEntries(
          unique([
            ...registration.gates,
            ...registration.cases.flatMap((item) => item.gates),
          ])
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
              (item) =>
                classify(unique([...registration.gates, ...item.gates])) ===
                'manual',
            )
        ).map((item) => ({
          title: item.title ?? null,
          command: manualCommand(
            file,
            unique([...registration.gates, ...item.gates]),
          ),
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
      additions[entry.group].push({ file: entry.file });
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
      additions[item.group].push({ file: entry.file, title: item.title });
    }
  }
  for (const [group, items] of Object.entries(additions)) {
    const step = steps.find((step) =>
      step.run.includes(`ci-integration-tests.mjs run ${group}`),
    );
    if (!step) throw Error(`Missing CI collection step: ${group}`);
    for (const item of items) {
      const entry = entries.find((entry) => entry.file === item.file);
      const gates = unique([
        ...entry.gates,
        ...(item.title
          ? entry.cases.find((test) => test.title === item.title).gates
          : []),
      ]);
      if (!enabled(gates, step.env))
        throw Error(
          `Collection step disables ${item.file}: ${gates.join(',')}`,
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

export function audit(entries, report, filters, env, pattern) {
  const result = [];
  for (const entry of entries.filter(
    (entry) => entry.group !== 'manual' && matches(entry.file, filters),
  )) {
    const suite = report.testResults.find(
      (suite) =>
        relative(process.cwd(), suite.name).replaceAll('\\', '/') ===
        entry.file,
    );
    if (!suite?.assertionResults.length)
      throw Error(`Not collected: ${entry.file}`);
    if (entry.gates.some((gate) => !env[gate])) {
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
      if (test.status === 'passed') {
        passed++;
        continue;
      }
      const condition = entry.cases.find((item) => item.title === test.title);
      if (
        ['pending', 'skipped'].includes(test.status) &&
        condition &&
        condition.gates.some((gate) => !env[gate] || String(env[gate]) === '0')
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
      const entry = plan.entries.find((entry) => entry.file === item.file);
      const gates = [
        ...entry.gates,
        ...(item.title
          ? entry.cases.find((test) => test.title === item.title).gates
          : []),
      ];
      if (gates.some((gate) => !process.env[gate]))
        throw Error(`Automatic runner gate is disabled: ${item.file}`);
    }
    const whole = items.filter((item) => !item.title),
      cases = items.filter((item) => item.title);
    for (const batch of [whole, cases]) {
      if (!batch.length) continue;
      const pattern =
        batch === cases
          ? batch
              .map((item) => item.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('|')
          : null;
      run(plan, [
        ...vitest,
        ...unique(batch.map((item) => item.file)),
        ...(pattern ? ['-t', pattern] : []),
      ]);
    }
  } else run(plan, vitest);
}
function run(plan, args) {
  const filters = tokens(args.join(' '));
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
  const child = spawnSync('pnpm', ['exec', 'vitest', 'run', ...command], {
    stdio: 'inherit',
    env: process.env,
  });
  if (child.error || child.status !== 0) {
    process.exitCode = child.status || 1;
    return;
  }
  const patternIndex = args.findIndex((arg) =>
    ['-t', '--testNamePattern'].includes(arg),
  );
  const evidence = audit(
    plan.entries,
    JSON.parse(read(report)),
    filters,
    process.env,
    patternIndex >= 0 ? args[patternIndex + 1] : undefined,
  );
  writeFileSync(
    `${report}.collection.json`,
    JSON.stringify({ head: plan.head, args, evidence }, null, 2) + '\n',
  );
  console.log(
    `Verified collection: ${evidence.length} files; ${evidence.reduce((total, item) => total + item.passed, 0)} passed assertions; ${evidence.reduce((total, item) => total + item.deferred.length, 0)} explicitly deferred assertions (not passes)`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
