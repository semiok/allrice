import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setImmediate, setTimeout } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';
import workerThreads from 'node:worker_threads';

const { AbortController, AbortSignal } = globalThis;

// Run against built packages and committed synthetic inputs. No model, account,
// managed Office VM or company data is needed. Observe real helper cancellation;
// do not replace the converter or its process implementation.
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = new URL('./fixtures/office/', import.meta.url);
const provenance = JSON.parse(
  readFileSync(new URL('provenance.json', fixtures), 'utf8'),
);
const originalSpawn = childProcess.spawn;
const OriginalWorker = workerThreads.Worker;
let cancelNextHelper;
let cancelNextWasmWorker;
workerThreads.Worker = class extends OriginalWorker {
  constructor(filename, options) {
    super(filename, options);
    const path =
      filename instanceof URL ? fileURLToPath(filename) : String(filename);
    if (
      cancelNextWasmWorker &&
      path.startsWith(root + 'node_modules/') &&
      path.includes('/libreoffice-kit/') &&
      path.endsWith('/worker.js')
    ) {
      const observer = cancelNextWasmWorker;
      cancelNextWasmWorker = undefined;
      observer(this);
    }
  }
};
childProcess.spawn = (...args) => {
  const child = originalSpawn(...args);
  if (
    cancelNextHelper &&
    String(args[0]).startsWith(root + 'node_modules/') &&
    String(args[0]).includes('libreoffice-kit')
  ) {
    const observer = cancelNextHelper;
    cancelNextHelper = undefined;
    observer(child, String(args[0]));
  }
  return child;
};
syncBuiltinESMExports();

const { previewOfficePdf } = await import(
  new URL('../../packages/office-runtime/dist/preview.js', import.meta.url)
);
const { readPdfDocument } = await import(
  new URL('../../packages/office-runtime/dist/pdf-reader.js', import.meta.url)
);
const requireOffice = createRequire(
  new URL('../../packages/office-runtime/package.json', import.meta.url),
);
const requireProvider = createRequire(
  requireOffice.resolve('@deepseek-ai/dsh-office-to-pdf'),
);
const kitEntry = requireProvider.resolve('@deepseek-ai/libreoffice-kit');
const requireKit = createRequire(kitEntry);
assert.equal(
  requireKit('@deepseek-ai/libreoffice-kit/package.json').version,
  '0.1.5',
);
const { discoverRuntime } = await import(pathToFileURL(kitEntry));
const runtime = await discoverRuntime();
assert.equal(runtime.backend, process.platform === 'linux' ? 'wasm' : 'native');

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const checks = [];
function check(value) {
  checks.push(value);
  if (process.env.ALLRICE_OFFICE_ACCEPTANCE_OUTPUT) {
    writeFileSync(
      process.env.ALLRICE_OFFICE_ACCEPTANCE_OUTPUT,
      JSON.stringify(
        { passed: false, incomplete: true, runtime, checks },
        null,
        2,
      ) + '\n',
    );
  }
  console.log(JSON.stringify({ check: value.name, passed: true }));
}
const source = (fixture) => {
  const bytes = readFileSync(new URL(fixture.file, fixtures));
  assert.equal(hash(bytes), fixture.sha256, fixture.file);
  assert.equal(bytes.length, fixture.bytes);
  return bytes;
};
const request = (fixture, objectId, read) => ({
  objectId,
  checksum: 'sha256:' + fixture.sha256,
  sizeBytes: fixture.bytes,
  format: fixture.format,
  read,
  signal: AbortSignal.timeout(60000),
});
async function text(pdf) {
  // PDF.js transfers the input buffer. Keep cached/result bytes caller-owned.
  return (await readPdfDocument({ bytes: Uint8Array.from(pdf) })).text.replace(
    /\s+/g,
    '',
  );
}
async function waitForExit(closed) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Conversion worker did not exit within 5s')),
      5000,
    );
    closed.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

try {
  const originals = new Map();
  for (const fixture of provenance.cases) {
    const bytes = source(fixture);
    let reads = 0;
    const input = request(
      fixture,
      'office-acceptance-' + fixture.format,
      async (signal, maximum) => {
        signal.throwIfAborted();
        assert.ok(bytes.length <= maximum);
        reads++;
        return bytes;
      },
    );
    const started = performance.now();
    const result = await previewOfficePdf(input);
    const pdf = Buffer.from(result.pdf);
    assert.ok(pdf.length > 500, fixture.file);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const content = await text(pdf);
    for (const expected of fixture.expectedText) {
      assert.ok(
        content.includes(expected),
        fixture.file + ': selectable ' + expected,
      );
    }
    const cached = await previewOfficePdf({
      ...input,
      read: async () =>
        assert.fail('Exact authorized version must use the provider cache'),
    });
    assert.equal(reads, 1);
    assert.deepEqual(Buffer.from(cached.pdf), pdf);
    assert.equal(cached.cacheKey, result.cacheKey);
    assert.equal(cached.generation, result.generation);
    originals.set(fixture.format, { input, pdf, key: result.cacheKey });
    check({
      name:
        fixture.format + ': actual PDF, Chinese/numbers and same-version cache',
      passed: true,
      sourceSha256: fixture.sha256,
      pdfSha256: hash(pdf),
      pdfBytes: pdf.length,
      missingFonts: result.missingFonts,
      elapsedMs: Math.round(performance.now() - started),
    });
  }

  const revision = provenance.revision;
  const revisionBytes = source(revision);
  const cancellation = new AbortController();
  const reason = new Error('office-acceptance-cancel');
  let helper;
  let wasmWorker;
  let wasmThreadId;
  let closed;
  if (runtime.backend === 'native') {
    cancelNextHelper = (child, executable) => {
      helper = { pid: child.pid, executable: basename(executable) };
      closed = new Promise((resolve) => child.once('close', resolve));
      setTimeout(() => cancellation.abort(reason), 5);
    };
  } else {
    cancelNextWasmWorker = (worker) => {
      wasmWorker = worker;
      wasmThreadId = worker.threadId;
      closed = new Promise((resolve) => worker.once('exit', resolve));
      worker.once('online', () =>
        setTimeout(() => cancellation.abort(reason), 5),
      );
    };
  }
  const cancelStarted = performance.now();
  const canceled = previewOfficePdf({
    ...request(
      revision,
      'office-acceptance-cancel-v2',
      async (signal, maximum) => {
        signal.throwIfAborted();
        assert.ok(revisionBytes.length <= maximum);
        return revisionBytes;
      },
    ),
    signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(60000)]),
  });
  await assert.rejects(canceled, (error) => error === reason);
  if (runtime.backend === 'native') {
    assert.ok(helper?.pid, 'Observed a real native helper before cancellation');
    await waitForExit(closed);
    assert.throws(() => process.kill(helper.pid, 0), { code: 'ESRCH' });
  } else {
    assert.ok(
      wasmWorker && wasmThreadId > 0,
      'Observed an actual WASM worker online',
    );
    await waitForExit(closed);
    assert.equal(wasmWorker.threadId, -1);
  }
  cancelNextHelper = undefined;
  cancelNextWasmWorker = undefined;
  check({
    name: 'cancellation settles before reuse',
    passed: true,
    backend: runtime.backend,
    physicalNativeHelper: helper ?? null,
    physicalWasmThread: wasmWorker
      ? { threadId: wasmThreadId, exitedThreadId: wasmWorker.threadId }
      : null,
    wasmScope: wasmWorker
      ? 'Observed conversion worker online and physically exited; exact in-document computation stage is not asserted'
      : null,
    elapsedMs: Math.round(performance.now() - cancelStarted),
  });

  // Same immutable object identity, different checksum/version; retain both.
  const original = originals.get('docx');
  const updated = await previewOfficePdf(
    request(revision, original.input.objectId, async () => revisionBytes),
  );
  const updatedPdf = Buffer.from(updated.pdf);
  assert.ok((await text(updatedPdf)).includes('RevisionTwo'));
  assert.ok((await text(updatedPdf)).includes('310.75'));
  assert.notEqual(updated.cacheKey, original.key);
  assert.notEqual(hash(updatedPdf), hash(original.pdf));
  const historical = await previewOfficePdf(original.input);
  assert.deepEqual(Buffer.from(historical.pdf), original.pdf);
  check({
    name: 'corrected version and original version remain distinct',
    passed: true,
  });

  let entered;
  const entering = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  let sharedReads = 0;
  const sharedController = new AbortController();
  const shared = request(
    provenance.cases[0],
    'office-acceptance-shared',
    async (signal) => {
      sharedReads++;
      entered();
      await ready;
      signal.throwIfAborted();
      return source(provenance.cases[0]);
    },
  );
  const first = previewOfficePdf({
    ...shared,
    signal: sharedController.signal,
  }).then(
    () => assert.fail('Canceled reader resolved'),
    (error) => error,
  );
  await entering;
  const second = previewOfficePdf(shared);
  await new Promise((resolve) => setImmediate(resolve));
  sharedController.abort(reason);
  release();
  assert.equal(await first, reason);
  assert.ok((await second).pdf.byteLength > 500);
  assert.equal(sharedReads, 1);
  check({
    name: 'one canceled shared reader does not cancel the remaining reader',
    passed: true,
  });

  let rejectedReads = 0;
  const forbiddenRead = async () => {
    rejectedReads++;
    assert.fail('Rejected input was read');
  };
  await assert.rejects(
    previewOfficePdf({
      ...original.input,
      objectId: 'too-large',
      sizeBytes: 50 * 1024 * 1024 + 1,
      read: forbiddenRead,
    }),
    { code: 'input-too-large' },
  );
  await assert.rejects(
    previewOfficePdf({
      ...original.input,
      objectId: 'already-stopped',
      signal: AbortSignal.abort(reason),
      read: forbiddenRead,
    }),
    (error) => error === reason,
  );
  assert.equal(rejectedReads, 0);
  check({
    // Format is a closed OfficeExtension at this provider boundary. Actual
    // user MIME/extension rejection before IO is covered by the Worker and
    // workbench dispatch tests; do not send an out-of-contract JS value here.
    name: 'oversized and already-canceled requests do no source IO',
    passed: true,
  });

  const report = {
    passed: true,
    at: new Date().toISOString(),
    runtime,
    checks,
    paidModelRuns: 0,
    scope:
      'Actual compiled preview wrapper/provider and fixed simple documents; not complex Office fidelity, tenant HTTP authorization or managed Office VM acceptance.',
  };
  if (process.env.ALLRICE_OFFICE_ACCEPTANCE_OUTPUT) {
    writeFileSync(
      process.env.ALLRICE_OFFICE_ACCEPTANCE_OUTPUT,
      JSON.stringify(report, null, 2) + '\n',
    );
  }
  console.log(JSON.stringify(report));
} finally {
  cancelNextHelper = undefined;
  cancelNextWasmWorker = undefined;
  childProcess.spawn = originalSpawn;
  workerThreads.Worker = OriginalWorker;
  syncBuiltinESMExports();
}
