import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';

const json = (value) => {
  const ancestors = [];
  return JSON.stringify(
    value,
    function (_key, item) {
      if (typeof item === 'bigint') return String(item);
      if (!item || typeof item !== 'object') return item;
      while (ancestors.length && ancestors.at(-1).encoded !== this)
        ancestors.pop();
      if (ancestors.some((entry) => entry.original === item))
        return '[Circular]';
      const encoded =
        item instanceof Error
          ? {
              ...item,
              name: item.name,
              message: item.message,
              stack: item.stack,
              cause: item.cause,
            }
          : item;
      ancestors.push({ original: item, encoded });
      return encoded;
    },
    2,
  );
};

/** Test-only memory observations. No filesystem or browser capture until failure. */
export function createFailureEvidence({ file, test, collect, root } = {}) {
  const startedAt = new Date().toISOString(),
    started = performance.now(),
    timeline = [],
    pages = [],
    removeListeners = [];
  let capturing,
    droppedTimelineEvents = 0;
  const mark = (phase, details) => {
    if (timeline.length === 1024) {
      timeline.shift();
      droppedTimelineEvents++;
    }
    timeline.push({ elapsedMs: performance.now() - started, phase, details });
  };
  const listen = (target, event, listener) => {
    target.on(event, listener);
    removeListeners.push(() => target.off(event, listener));
  };
  const observePage = (page) => {
    pages.push(page);
    for (const event of ['request', 'requestfinished', 'requestfailed'])
      listen(page, event, (request) =>
        mark(event, {
          url: request.url(),
          method: request.method(),
          failure: request.failure(),
        }),
      );
    listen(page, 'response', (response) => {
      const headers = response.headers();
      mark('response', {
        url: response.url(),
        status: response.status(),
        contentType: headers['content-type'],
        contentSecurityPolicy: headers['content-security-policy'],
      });
    });
    listen(page, 'console', (message) =>
      mark('console', {
        type: message.type(),
        text: message.text(),
      }),
    );
    listen(page, 'pageerror', (error) => mark('pageerror', error));
    for (const event of ['frameattached', 'framenavigated', 'framedetached'])
      listen(page, event, (frame) =>
        mark(event, { url: frame.url(), name: frame.name() }),
      );
    for (const event of ['crash', 'close'])
      listen(page, event, () => mark(`page-${event}`));
    listen(page, 'download', (download) =>
      mark('download', {
        url: download.url(),
        filename: download.suggestedFilename(),
      }),
    );
    const browser = page.context().browser();
    if (browser)
      listen(browser, 'disconnected', () => mark('browser-disconnected'));
    mark('page-observed');
  };
  const capture = (errors) =>
    (capturing ??= (async () => {
      try {
        const batch = process.env.ALLRICE_CI_COLLECTION_BATCH;
        const parent =
          root ??
          (batch
            ? join(dirname(resolve(batch)), 'test-failure-evidence')
            : resolve('.local/test-failure-evidence'));
        await mkdir(parent, { recursive: true });
        const directory = await mkdtemp(join(parent, 'failure-'));
        const evidence = {
          file,
          test,
          startedAt,
          failedAt: new Date().toISOString(),
          pid: process.pid,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          collectionBatch: batch,
          errors,
          timeline,
          captureErrors: [],
          pages: [],
          droppedTimelineEvents,
        };
        const save = () =>
          writeFile(join(directory, 'evidence.json'), json(evidence));
        // Preserve the original error/timeline even if a live browser cannot respond.
        await save();
        const attempt = async (label, work) => {
          let timer;
          try {
            return await Promise.race([
              Promise.resolve().then(work),
              new Promise((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(Error(`Capture timed out: ${label}`)),
                  2000,
                );
              }),
            ]);
          } catch (error) {
            evidence.captureErrors.push({ label, error });
          } finally {
            clearTimeout(timer);
          }
        };
        evidence.details = await attempt('fixture', () => collect?.());
        await Promise.all(
          pages.map(async (page, index) => {
            const browser = page.context().browser();
            evidence.pages.push({
              index,
              closed: page.isClosed(),
              url: page.url(),
              browserConnected: browser?.isConnected(),
              browserVersion: browser?.version(),
              frames: page
                .frames()
                .map((frame) => ({ url: frame.url(), name: frame.name() })),
            });
            if (page.isClosed()) return;
            await Promise.all([
              attempt(`page-${index}-dom`, async () =>
                writeFile(
                  join(directory, `page-${index}.html`),
                  await page.content(),
                ),
              ),
              attempt(`page-${index}-screenshot`, () =>
                page.screenshot({
                  path: join(directory, `page-${index}.png`),
                  timeout: 1500,
                }),
              ),
            ]);
          }),
        );
        evidence.droppedTimelineEvents = droppedTimelineEvents;
        await save();
        console.error('TEST_FAILURE_EVIDENCE', directory);
        return directory;
      } catch (error) {
        // Diagnostics must never replace the test's first assertion or timeout.
        console.error('TEST_FAILURE_EVIDENCE_WRITE_FAILED', error);
      }
    })());
  return {
    mark,
    observePage,
    capture,
    dispose() {
      removeListeners.splice(0).forEach((remove) => remove());
    },
  };
}

/** Keep test resources local even when an acquisition outlives the test timeout. */
export function createFailureCleanup(evidence) {
  const cleanups = [];
  let ended = false,
    finishing;
  const check = () => {
    if (ended) throw Error('TEST_RESOURCE_SCOPE_ENDED');
  };
  return {
    check,
    own(close) {
      let closed = false;
      const dispose = async () => {
        if (closed) return;
        closed = true;
        await close();
      };
      const owner = {
        replace(next) {
          check();
          close = next;
        },
      };
      if (ended)
        owner.late = dispose().then(() => {
          throw Error('TEST_RESOURCE_SCOPE_ENDED');
        });
      else cleanups.push(dispose);
      return owner;
    },
    finish(result) {
      ended = true;
      return (finishing ??= (async () => {
        const errors = [];
        try {
          if (result?.state === 'fail') await evidence.capture(result.errors);
        } finally {
          try {
            for (const close of cleanups.reverse()) {
              try {
                await close();
              } catch (error) {
                errors.push(error);
              }
            }
          } finally {
            evidence.dispose();
          }
        }
        if (errors.length) throw errors[0];
      })());
    },
  };
}
