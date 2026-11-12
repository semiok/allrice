import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFailureEvidence } from './test-failure-evidence.mjs';

const roots = [];
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function directory() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-failure-evidence-')),
  );
  roots.push(root);
  return root;
}
function browserPage() {
  const browser = Object.assign(new EventEmitter(), {
    version: () => 'synthetic-browser',
    isConnected: () => true,
  });
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ browser: () => browser }),
    isClosed: () => false,
    url: () => 'http://synthetic.test/',
    frames: () => [],
    content: vi.fn(async () => '<html>failure DOM</html>'),
    screenshot: vi.fn(async ({ path }) =>
      writeFile(path, 'synthetic screenshot'),
    ),
  });
  return { page, browser };
}

it('successful observations and disposal do not create artifacts or capture a browser', async () => {
  const root = await directory();
  const { page, browser } = browserPage();
  const evidence = createFailureEvidence({
    file: import.meta.url,
    test: 'success',
    root,
  });
  evidence.observePage(page);
  evidence.mark('expected-csp-rejection-observed');
  evidence.dispose();
  expect(await readdir(root)).toEqual([]);
  expect(page.content).not.toHaveBeenCalled();
  expect(page.screenshot).not.toHaveBeenCalled();
  expect(page.listenerCount('response')).toBe(0);
  expect(browser.listenerCount('disconnected')).toBe(0);
});

it('stores the original error, bounded timeline and live browser once beside the collection batch', async () => {
  const root = await directory(),
    batch = join(root, 'batch', 'batch.json');
  vi.stubEnv('ALLRICE_CI_COLLECTION_BATCH', batch);
  const { page } = browserPage();
  const shared = { value: 'unchanged snapshot' },
    circular = {};
  circular.self = circular;
  const evidence = createFailureEvidence({
    file: import.meta.url,
    test: 'failed',
    collect: () => ({ first: shared, second: shared, circular }),
  });
  evidence.observePage(page);
  for (let n = 0; n < 1100; n++) evidence.mark('stage', { n });
  page.emit('response', {
    url: () => 'http://synthetic.test/',
    status: () => 200,
    headers: () => ({
      'content-type': 'text/html',
      'content-security-policy': 'frame-ancestors self',
      'set-cookie': 'omit',
    }),
  });
  const original = new Error('first assertion', {
    cause: new Error('underlying error'),
  });
  const capture = evidence.capture(original);
  expect(evidence.capture(Error('later cleanup'))).toBe(capture);
  const artifact = await capture;
  expect(dirname(artifact)).toBe(join(dirname(batch), 'test-failure-evidence'));
  const saved = JSON.parse(
    await readFile(join(artifact, 'evidence.json'), 'utf8'),
  );
  expect(saved.errors).toMatchObject({
    message: 'first assertion',
    cause: { message: 'underlying error' },
  });
  expect(saved.timeline).toHaveLength(1024);
  expect(saved.droppedTimelineEvents).toBeGreaterThan(0);
  expect(saved.details).toEqual({
    first: shared,
    second: shared,
    circular: { self: '[Circular]' },
  });
  expect(saved.timeline.at(-1).details).toEqual({
    url: 'http://synthetic.test/',
    status: 200,
    contentType: 'text/html',
    contentSecurityPolicy: 'frame-ancestors self',
  });
  expect(await readFile(join(artifact, 'page-0.html'), 'utf8')).toContain(
    'failure DOM',
  );
  expect(page.screenshot).toHaveBeenCalledTimes(1);
  evidence.dispose();
});

it('keeps the first failure when fixture and browser collection fail', async () => {
  const root = await directory(),
    { page } = browserPage();
  page.content.mockRejectedValue(Error('browser disconnected'));
  page.screenshot.mockRejectedValue(Error('browser closed'));
  const evidence = createFailureEvidence({
    file: import.meta.url,
    test: 'capture failure',
    root,
    collect: () => {
      throw Error('fixture unavailable');
    },
  });
  evidence.observePage(page);
  const artifact = await evidence.capture(Error('original timeout'));
  const saved = JSON.parse(
    await readFile(join(artifact, 'evidence.json'), 'utf8'),
  );
  expect(saved.errors.message).toBe('original timeout');
  expect(saved.captureErrors.map((entry) => entry.label).sort()).toEqual([
    'fixture',
    'page-0-dom',
    'page-0-screenshot',
  ]);
  evidence.dispose();
});

it('does not replace an assertion when the artifact directory cannot be written', async () => {
  const root = join(await directory(), 'file');
  await writeFile(root, 'not a directory');
  const original = Error('original assertion');
  const evidence = createFailureEvidence({
    file: import.meta.url,
    test: 'write failure',
    root,
  });
  const operation = async () => {
    try {
      throw original;
    } catch (error) {
      await evidence.capture(error);
      throw error;
    }
  };
  await expect(operation()).rejects.toBe(original);
  expect(console.error).toHaveBeenCalledWith(
    'TEST_FAILURE_EVIDENCE_WRITE_FAILED',
    expect.any(Error),
  );
});

it('preserves a real assertion during slow afterEach capture, captures overall timeouts before cleanup, and leaves passing cases without artifacts', async () => {
  const root = await directory(),
    artifacts = join(root, 'artifacts');
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  await writeFile(
    join(root, 'vitest.config.mjs'),
    `export default {test:{include:['scenario.test.mjs']}}`,
  );
  await writeFile(
    join(root, 'scenario.test.mjs'),
    `
import {afterEach,beforeEach,expect,it} from 'vitest';
import {setTimeout as delay} from 'node:timers/promises';
import {createFailureEvidence} from ${JSON.stringify(fileURLToPath(new URL('./test-failure-evidence.mjs', import.meta.url)))};
let evidence, closed;
beforeEach(({task}) => {
  closed=false;
  evidence=createFailureEvidence({file:import.meta.url,test:task.name,root:${JSON.stringify(artifacts)},collect:async()=>{
    if(task.name==='original assertion') {
      const started=performance.now();
      await delay(80);
      return {closed,captureElapsedMs:performance.now()-started};
    }
    return {closed};
  }});
});
afterEach(async ({task}) => {
  try {
    if(task.result?.state==='fail') await evidence.capture(task.result.errors);
  } finally {
    closed=true;
  }
});
it('passing observation',()=>{evidence.mark('passed');});
it('overall timeout',()=>{evidence.mark('pending');return new Promise(()=>{});},30);
it('original assertion',()=>{expect(1,'original assertion must survive capture').toBe(2);},30);
`,
  );
  const env = { ...process.env, ALLRICE_CI_COLLECTION_BATCH: '' };
  for (const name of ['VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID'])
    delete env[name];
  const result = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(
        new URL('../node_modules/vitest/vitest.mjs', import.meta.url),
      ),
      'run',
      '--config',
      join(root, 'vitest.config.mjs'),
      '--maxWorkers=1',
      '--reporter=json',
      `--outputFile=${join(root, 'report.json')}`,
    ],
    { cwd: root, env, timeout: 15000 },
  ).catch((error) => error);
  expect(result.code).toBe(1);
  const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'));
  expect(report).toMatchObject({ numPassedTests: 1, numFailedTests: 2 });
  const assertion = report.testResults
    .flatMap((file) => file.assertionResults)
    .find((test) => test.title === 'original assertion');
  expect(assertion.failureMessages.join('\n')).toContain(
    'original assertion must survive capture',
  );
  expect(assertion.failureMessages.join('\n')).not.toContain('Test timed out');
  const entries = await readdir(artifacts);
  expect(entries).toHaveLength(2);
  const saved = await Promise.all(
    entries.map(async (entry) =>
      JSON.parse(
        await readFile(join(artifacts, entry, 'evidence.json'), 'utf8'),
      ),
    ),
  );
  const timeoutEvidence = saved.find((item) => item.test === 'overall timeout');
  expect(timeoutEvidence.details).toEqual({ closed: false });
  expect(timeoutEvidence.errors[0].message).toContain('timed out');
  const assertionEvidence = saved.find(
    (item) => item.test === 'original assertion',
  );
  expect(assertionEvidence.details.closed).toBe(false);
  expect(assertionEvidence.details.captureElapsedMs).toBeGreaterThan(30);
  expect(assertionEvidence.errors[0].message).toContain(
    'original assertion must survive capture',
  );
}, 20000);
