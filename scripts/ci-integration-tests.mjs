import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const read = (path) => readFileSync(path, 'utf8');
const save = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const unique = (values) => [...new Set(values)].sort();
const matches = (file, paths) =>
  paths.some(
    (path) => file === path || file.startsWith(path.replace(/\/$/, '') + '/'),
  );
const present = (env, key) => !!env[key] && String(env[key]) !== '0';
const manualFile = (entry) => entry.group.startsWith('manual');
const ready = (entry, env) =>
  !manualFile(entry) && entry.needs.every((gate) => present(env, gate));
const manifest = (root) =>
  parse(read(resolve(root, 'scripts/ci-manual-environments.yml')));
const git = (root, args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const identity = (root) => git(root, ['rev-parse', 'HEAD']);
const commandFiles = (run) =>
  run.match(/(?:apps|packages|tests|scripts|infra)\/[\w./-]+/g) ?? [];
export const testTags = (root = process.cwd()) =>
  Object.entries(manifest(root).tags).map(([name, value]) => ({
    name,
    description: value.reason,
  }));

// Literal workflow commands describe plans, never execution evidence. Neither
// arbitrary shell nor potential, unregistered TS branches are interpreted.
export function inventory(root = process.cwd()) {
  const data = manifest(root);
  const files = git(root, ['ls-files', '-z'])
    .split('\0')
    .filter((file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file));
  const declared = new Map();
  for (const [group, paths] of Object.entries(data.files)) {
    if (!data.resources[group]) throw Error(`Unknown resource: ${group}`);
    for (const file of paths) {
      if (!files.includes(file) || declared.has(file))
        throw Error(`Missing or conflicting resource file: ${file}`);
      declared.set(file, group);
    }
  }
  for (const [tag, value] of Object.entries(data.tags))
    if (
      !/^(manual|platform):[\w-]+$/.test(tag) ||
      !value.reason ||
      !value.command?.includes('{file}')
    )
      throw Error(`Invalid manual/platform declaration: ${tag}`);
  const entries = files
    .filter(
      (file) =>
        /\.(integration|browser)\.test\./.test(file) || declared.has(file),
    )
    .map((file) => {
      const rules = Object.entries(data.rules).filter(([, paths]) =>
        matches(file, paths),
      );
      const group =
        declared.get(file) ?? (rules.length === 1 ? rules[0][0] : null);
      if (!group || !data.resources[group])
        throw Error(`Unclassified or conflicting candidate: ${file}`);
      const needs = unique([
        ...data.resources[group],
        ...Object.entries(data.extra)
          .filter(([, paths]) => paths.includes(file))
          .map(([gate]) => gate),
      ]);
      return { file, group, needs, plannedBy: [] };
    });
  const workflow = parse(read(resolve(root, '.github/workflows/ci.yml')));
  const steps = Object.entries(workflow.jobs)
    .flatMap(([job, value]) =>
      value.steps.map((step) => ({
        ...step,
        job,
        run: step.run ?? '',
        env: { ...workflow.env, ...value.env, ...step.env },
      })),
    )
    .filter((step) => step.run.includes('ci-integration-tests.mjs run'));
  for (const entry of entries)
    entry.plannedBy = steps
      .filter((step) => {
        if (/\s(?:-t|--testNamePattern)(?:\s|=)/.test(step.run)) return false;
        const filters = step.run.includes(
          'ci-integration-tests.mjs run native --',
        )
          ? files
          : commandFiles(step.run);
        return ready(entry, step.env) && matches(entry.file, filters);
      })
      .map((step) => `${step.job}: ${step.name}`);
  const additions = { db: [], browser: [], 'browser+db': [] };
  for (const entry of entries) {
    if (manualFile(entry) || entry.plannedBy.length) continue;
    if (!additions[entry.group])
      throw Error(`No responsible CI batch: ${entry.file}`);
    additions[entry.group].push(entry.file);
  }
  for (const [group, paths] of Object.entries(additions)) {
    const step = steps.find((step) =>
      step.run.includes(`ci-integration-tests.mjs run ${group} --`),
    );
    if (
      !step ||
      !entries
        .filter((entry) => paths.includes(entry.file))
        .every((entry) => ready(entry, step.env))
    )
      throw Error(`Missing or disabled supplement: ${group}`);
  }
  return { head: identity(root), files, entries, additions, tags: data.tags };
}

export function auditInstances(
  batch,
  collected,
  results,
  modules,
  unhandled,
  reason,
) {
  const errors = [],
    instances = [],
    seen = new Set();
  const fail = (message) => errors.push(message);
  const entries = new Map(batch.entries.map((entry) => [entry.file, entry]));
  const completed = new Map(modules.map((module) => [module.file, module]));
  for (const file of batch.expected) {
    const tests = collected[file],
      module = completed.get(file);
    if (!tests?.length || !module?.ended) {
      fail(`Missing/empty/unfinished module: ${file}`);
      continue;
    }
    if (module.errors.length || !['passed', 'skipped'].includes(module.state))
      fail(`Module error: ${file}: ${module.errors.join('; ')}`);
    if (module.tests.length !== tests.length)
      fail(`Changed instance set: ${file}`);
    const entry = entries.get(file) ?? { group: 'native', needs: [] };
    const responsible = ready(entry, batch.env);
    const final = new Map(module.tests.map((test) => [test.id, test]));
    for (const test of tests) {
      if (seen.has(test.id)) fail(`Duplicate collected ID: ${test.id}`);
      seen.add(test.id);
      const result = final.get(test.id);
      if (
        !result ||
        result.name !== test.name ||
        JSON.stringify(result.tags) !== JSON.stringify(test.tags)
      ) {
        fail(`Missing/changed instance: ${file}: ${test.id}`);
        continue;
      }
      const tags = test.tags.map((tag) => {
        const value = batch.tags[tag];
        if (!value) fail(`Unknown test tag: ${tag}: ${file}`);
        return [tag, value];
      });
      const manual = tags.some(([tag]) => tag.startsWith('manual:'));
      const unavailable = tags.filter(
        ([tag, value]) =>
          value &&
          (tag.startsWith('manual:')
            ? !present(batch.env, tag.slice(7))
            : !!value.negate ===
              (value.platforms.includes(batch.platform) &&
                (!value.archs || value.archs.includes(batch.arch)))),
      );
      const filtered =
        batch.pattern && !new RegExp(batch.pattern).test(test.name);
      let disposition = 'executed';
      if (manualFile(entry) && !manual)
        fail(`Manual file contains an automatic leaf: ${file}: ${test.name}`);
      if (result.state === 'skipped') {
        disposition = filtered
          ? 'filtered'
          : unavailable.length
            ? 'manual'
            : !responsible && !manualFile(entry)
              ? 'resource'
              : 'unexpected-skip';
        if (disposition === 'unexpected-skip')
          fail(`Unknown/enabled skip: ${file}: ${test.name}`);
      } else if (result.state !== 'passed')
        fail(
          `Failed/unfinished instance: ${file}: ${test.name}: ${result.state}`,
        );
      else if (unavailable.length)
        fail(`Unavailable tagged leaf executed: ${file}: ${test.name}`);
      const events = results[test.id] ?? [];
      if (
        result.state !== 'skipped' &&
        (!events.length || events.at(-1) !== result.state)
      )
        fail(`Missing case result event: ${file}: ${test.id}`);
      const assignments = tags.map(([, value]) =>
        value?.command.split('pnpm exec vitest run ')[0].trim(),
      );
      assignments.push(...entry.needs.map((gate) => `${gate}=1`));
      instances.push({
        ...test,
        state: result.state,
        resultEvents: events,
        retries: result.retries,
        disposition,
        responsible: responsible && !batch.partial,
        manual: manual || disposition === 'manual',
        command: tags.length
          ? unique(assignments).filter(Boolean).join(' ') +
            ` pnpm exec vitest run ${file} --maxWorkers=2`
          : undefined,
      });
    }
  }
  for (const module of modules)
    if (!batch.expected.includes(module.file))
      fail(`Unexpected module: ${module.file}`);
  for (const id of Object.keys(results))
    if (!seen.has(id)) fail(`Uncollected result ID: ${id}`);
  if (unhandled.length || reason !== 'passed')
    fail(`Run ${reason}: ${unhandled.join('; ')}`);
  return { complete: true, errors, instances };
}

const snapshot = (test) => ({
  id: test.id,
  name: test.fullName,
  tags: test.tags,
  location: test.location,
});
export default class CollectionReporter {
  collected = {};
  results = {};
  ended = new Set();
  onInit(ctx) {
    this.ctx = ctx;
    this.path = process.env.ALLRICE_CI_COLLECTION_BATCH;
    this.batch = JSON.parse(read(this.path));
  }
  onTestModuleCollected(module) {
    this.collected[relative(this.batch.root, module.moduleId)] = [
      ...module.children.allTests(),
    ].map(snapshot);
    appendFileSync(
      this.path + '.collected.jsonl',
      JSON.stringify({
        file: relative(this.batch.root, module.moduleId),
        tests: this.collected[relative(this.batch.root, module.moduleId)],
      }) + '\n',
    );
  }
  onTestCaseResult(test) {
    (this.results[test.id] ??= []).push(test.result().state);
  }
  onTestModuleEnd(module) {
    this.ended.add(module.moduleId);
  }
  onTestRunEnd(modules, unhandled, reason) {
    const final = modules.map((module) => ({
      file: relative(this.batch.root, module.moduleId),
      state: module.state(),
      ended: this.ended.has(module.moduleId),
      errors: [module, ...module.children.allSuites()].flatMap((suite) =>
        suite.errors().map((error) => error.message),
      ),
      tests: [...module.children.allTests()].map((test) => ({
        ...snapshot(test),
        state: test.result().state,
        retries: test.diagnostic()?.retryCount,
      })),
    }));
    save(
      this.path + '.instances.json',
      auditInstances(
        { ...this.batch, pattern: this.ctx.config.testNamePattern?.source },
        this.collected,
        this.results,
        final,
        unhandled.map((error) => error.message),
        reason,
      ),
    );
  }
}

function run(plan, args, group) {
  const root = process.cwd();
  const filters = args.filter(
    (arg) =>
      !arg.startsWith('-') && plan.files.some((file) => matches(file, [arg])),
  );
  const expected =
    group === 'native'
      ? plan.files
      : plan.files.filter((file) => matches(file, filters));
  if (!expected.length) throw Error('Explicit test files/directories required');
  const base = resolve('.local/integration-collection');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(resolve(base, `${group ?? 'explicit'}-`));
  const path = resolve(directory, 'batch.json');
  const supplied = args.find((arg) => arg.startsWith('--outputFile='));
  const report =
    supplied?.slice('--outputFile='.length) ??
    resolve(directory, 'vitest.json');
  mkdirSync(dirname(report), { recursive: true });
  const gates = unique([
    ...plan.entries.flatMap((entry) => entry.needs),
    ...Object.keys(plan.tags)
      .filter((tag) => tag.startsWith('manual:'))
      .map((tag) => tag.slice(7)),
  ]);
  const batch = {
    root,
    head: plan.head,
    group,
    expected,
    entries: plan.entries,
    tags: plan.tags,
    env: Object.fromEntries(
      gates.map((gate) => [gate, process.env[gate] ?? '']),
    ),
    platform: process.platform,
    arch: process.arch,
    partial: args.some((arg) =>
      /^(?:-t|--testNamePattern|--testTagsFilter)(?:=|$)/.test(arg),
    ),
  };
  save(path, batch);
  let receipt = {
    head: plan.head,
    directory,
    report,
    complete: false,
    exitCode: 1,
  };
  const receiptPath = resolve(directory, 'receipt.json');
  save(receiptPath, receipt);
  try {
    if (existsSync(report))
      throw Error(`Original report already exists: ${report}`);
    const child = spawnSync(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--includeTaskLocation',
        ...args,
        '--reporter=default',
        '--reporter=json',
        `--reporter=${fileURLToPath(import.meta.url)}`,
        ...(!supplied ? [`--outputFile=${report}`] : []),
      ],
      {
        stdio: 'inherit',
        env: { ...process.env, ALLRICE_CI_COLLECTION_BATCH: path },
      },
    );
    receipt.vitestExitCode = child.status;
    receipt.exitCode = child.status ?? 1;
    if (
      existsSync(report) &&
      resolve(report) !== resolve(directory, 'vitest.json')
    )
      copyFileSync(report, resolve(directory, 'vitest.json'));
    if (child.error || child.signal || child.status !== 0)
      throw Error(
        `Vitest failed/interrupted: ${child.error?.message ?? child.signal ?? child.status}`,
      );
    const instances = JSON.parse(read(path + '.instances.json'));
    if (!instances.complete || instances.errors.length)
      throw Error(
        instances.errors?.join('\n') ?? 'Incomplete instance receipt',
      );
    if (!JSON.parse(read(report)).success)
      throw Error('Original JSON report is unsuccessful');
    if (identity(root) !== batch.head)
      throw Error('Git SHA changed during batch');
    receipt = {
      ...receipt,
      complete: true,
      exitCode: 0,
      counts: Object.fromEntries(
        ['passed', 'failed', 'skipped', 'pending'].map((state) => [
          state,
          instances.instances.filter((test) => test.state === state).length,
        ]),
      ),
    };
  } catch (error) {
    receipt.error = error.message;
    receipt.exitCode = 1;
    process.exitCode = 1;
  } finally {
    save(receiptPath, receipt);
  }
  return receipt;
}

function main() {
  const [action, ...args] = process.argv.slice(2);
  const plan = inventory();
  if (action === 'inventory') return console.log(JSON.stringify(plan, null, 2));
  if (action !== 'run')
    throw Error(
      'Use inventory or run [native|db|browser|browser+db] -- [Vitest arguments]',
    );
  const group = args[0] === '--' ? null : args.shift();
  if (args.shift() !== '--') throw Error('Vitest arguments must follow --');
  if (group && group !== 'native') {
    const files = plan.additions[group];
    if (!files) throw Error(`Unknown group: ${group}`);
    if (!files.length) return console.log(`No additional ${group} files`);
    if (
      plan.entries.some(
        (entry) =>
          files.includes(entry.file) &&
          !entry.needs.every((gate) => present(process.env, gate)),
      )
    )
      throw Error(`Disabled ${group} resources`);
    args.push(...files);
  }
  console.log(JSON.stringify(run(plan, args, group)));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
