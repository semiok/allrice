/** Thin evidence adapter for existing Vitest reports. Never executes a command,
 * accesses a tenant database, or accepts a browser-supplied passing receipt. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  qualityRegressionScenarios,
  type QualityRegressionGroup,
} from '../../../packages/database/src/platform-quality-scenarios.ts';
import { managedPythonPayloadsV1 } from '../../../packages/contracts/src/managed-python-payload.ts';
import { bundleQualityEvidence } from '../../../packages/database/src/platform-quality-evidence-bundle.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const digest = (bytes: string | Buffer) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
import {
  collectQualityEvidence,
  type Capture,
  type VitestEvidence,
} from '../../../packages/database/src/platform-quality-evidence.ts';
export {
  collectQualityEvidence,
  type VitestEvidence,
} from '../../../packages/database/src/platform-quality-evidence.ts';
export function currentSource(cwd = root) {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('SOURCE_SHA_UNAVAILABLE');
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd },
  )
    .toString()
    .split('\0')
    .filter(Boolean);
  const hash = createHash('sha256');
  for (const name of [...new Set(files)].sort()) {
    const path = resolve(cwd, name);
    // A deleted tracked file contributes a tombstone, never an older Git blob.
    let bytes: Buffer;
    let missing = false;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw Error('SOURCE_FILE_UNREADABLE');
      missing = true;
      bytes = Buffer.alloc(0);
    }
    hash
      .update(name)
      .update('\0')
      .update(`${missing ? 'missing' : 'present'}:${bytes.length}:`)
      .update(bytes)
      .update('\0');
  }
  return {
    sha,
    treeDigest: 'sha256:' + hash.digest('hex'),
    dirty: !!execFileSync('git', ['status', '--porcelain=v1'], {
      cwd,
      encoding: 'utf8',
    }).trim(),
  };
}
function jsonFile(path: string) {
  if (statSync(path).size > 30_000_000) throw Error('EVIDENCE_TOO_LARGE');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function save(path: string, data: unknown) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}
async function main() {
  const [action, ...args] = process.argv.slice(2);
  const options = Object.fromEntries(
    args.map((arg) => {
      const m = /^--([a-z-]+)=(.+)$/.exec(arg);
      if (!m) throw Error('ARGUMENT_INVALID');
      return [m[1]!, m[2]!];
    }),
  );
  if (!options.output) throw Error('OUTPUT_REQUIRED');
  if (action === 'bundle') {
    if (!options['summary-files']) throw Error('SUMMARIES_REQUIRED');
    bundleQualityEvidence({
      directory: resolve(options.output),
      deployedSource: currentSource(),
      summaries: options['summary-files'].split(','),
      registries: options['registry-files']?.split(','),
    });
  } else if (action === 'capture') {
    if (!['native', 'postgres', 'office'].includes(options.group ?? ''))
      throw Error('GROUP_REQUIRED');
    const worker = jsonFile(resolve(root, 'apps/worker/package.json'));
    const web = jsonFile(resolve(root, 'apps/web/package.json'));
    const office = jsonFile(
      resolve(root, 'packages/office-runtime/package.json'),
    );
    save(options.output, {
      version: 1,
      group: options.group as QualityRegressionGroup,
      capturedAt: new Date().toISOString(),
      registryDigest: digest(JSON.stringify(qualityRegressionScenarios)),
      registrySnapshot: qualityRegressionScenarios,
      source: currentSource(),
      versions: {
        node: process.version,
        dshAgent: worker.dependencies['@deepseek-ai/dsh-agent'],
        dshWeb: web.dependencies['@deepseek-ai/dsh-client-ui-chat'],
        officeSkillPin: managedPythonPayloadsV1[0]!.officeChecker.upstream,
        officeConversionPackage:
          office.dependencies['@deepseek-ai/dsh-office-to-pdf'],
        lockDigest: digest(readFileSync(resolve(root, 'pnpm-lock.yaml'))),
        actualOfficeImage: null,
        actualBridgeVersion: null,
      },
    } satisfies Capture);
  } else if (action === 'collect') {
    if (
      !options.capture ||
      !!options.report === !!options['reports-dir'] ||
      !/^\d+$/.test(options['exit-code'] ?? '')
    )
      throw Error('COLLECT_ARGUMENTS_REQUIRED');
    if (options['reports-dir']) {
      const directory = resolve(options['reports-dir']);
      const paths = readdirSync(directory)
        .filter((name) => /^vitest-[a-z-]+\.json$/.test(name))
        .sort()
        .map((name) => resolve(directory, name));
      if (!paths.length) throw Error('REPORT_MISSING');
      const inputs = paths.map((path) => ({
        path,
        checksum: digest(readFileSync(path)),
        report: jsonFile(path) as VitestEvidence,
      }));
      options.report = resolve(directory, 'combined-report.json');
      save(options.report, {
        startTime: Math.min(...inputs.map((v) => v.report.startTime)),
        success: inputs.every((v) => v.report.success === true),
        testResults: inputs.flatMap((v) => v.report.testResults),
        originalReports: inputs.map(({ path, checksum }) => ({
          path,
          checksum,
        })),
      });
    }
    if (!options.report) throw Error('REPORT_MISSING');
    const bytes = readFileSync(options.report);
    const recordedAt = new Date().toISOString();
    const report = collectQualityEvidence({
      capture: jsonFile(options.capture),
      current: currentSource(),
      cwd: root,
      report: jsonFile(options.report),
      reportChecksum: digest(bytes),
      reportPath: resolve(options.report),
      exitCode: Number(options['exit-code']),
    });
    // Preserve the existing runner's actual exit independently of the derived
    // display summary. This is a receipt, never another test execution.
    save(resolve(dirname(options.output), 'execution.json'), {
      version: 1,
      recordedAt,
      captureChecksum: digest(readFileSync(options.capture)),
      reportChecksum: digest(bytes),
      executionExitCode: Number(options['exit-code']),
    });
    save(options.output, report);
    if (
      !report.runnerSucceeded ||
      report.scenarios.some((s) =>
        ['unknown', 'assertion_failed', 'execution_failed', 'skipped'].includes(
          s.status,
        ),
      )
    )
      process.exitCode = 1;
  } else throw Error('ACTION_INVALID');
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error: unknown) => {
    console.error(
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'EVIDENCE_COLLECTION_FAILED',
    );
    process.exitCode = 1;
  });
}
