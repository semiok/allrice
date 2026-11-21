import type { Page } from 'playwright-core';

export function causalJournal() {
  const events: {
    seq: number;
    receivedAt: number;
    side: string;
    name: string;
    data: unknown;
  }[] = [];
  return {
    events,
    record(side: string, name: string, data: unknown) {
      events.push({
        seq: events.length,
        receivedAt: performance.now(),
        side,
        name,
        data,
      });
    },
  };
}

/** Passive public events only. This does not classify or waive any audit error. */
export async function observeCausalPage(
  page: Page,
  side: string,
  journal: ReturnType<typeof causalJournal>,
) {
  const session = await page.context().newCDPSession(page);
  const errors: unknown[] = [];
  const cdpFailures: unknown[] = [];
  let layerIds: string[] | undefined;
  const requests = new Map<
    string,
    {
      id: string;
      url: string;
      method: string;
      status?: number;
      finished?: boolean;
      failure?: string;
      canceled?: boolean;
    }
  >();
  const waiters = new Set<() => void>();
  const cancellations = new Set<() => void>();
  let closed = false;
  const record = (name: string, data: unknown) =>
    journal.record(side, name, data);
  session.on('close', () => {
    closed = true;
    record('CDP.close', {});
    for (const cancel of cancellations) cancel();
  });
  session.on('Network.requestWillBeSent', (event) => {
    record('Network.requestWillBeSent', event);
    if (requests.has(event.requestId) && !event.redirectResponse)
      errors.push({ duplicateRequestId: event.requestId });
    requests.set(event.requestId, {
      id: event.requestId,
      url: event.request.url,
      method: event.request.method,
    });
  });
  session.on('Network.responseReceived', (event) => {
    record('Network.responseReceived', event);
    const request = requests.get(event.requestId);
    if (request) request.status = event.response.status;
    if (event.response.status >= 400) errors.push({ httpFailure: event });
  });
  session.on('Network.loadingFinished', (event) => {
    record('Network.loadingFinished', event);
    const request = requests.get(event.requestId);
    if (request) request.finished = true;
    for (const notify of waiters) notify();
  });
  session.on('Network.loadingFailed', (event) => {
    record('Network.loadingFailed', event);
    cdpFailures.push(event);
    const request = requests.get(event.requestId);
    if (request)
      Object.assign(request, {
        failure: event.errorText,
        canceled: event.canceled,
      });
    else errors.push({ unmatchedFailure: event });
    for (const notify of waiters) notify();
  });
  session.on('Log.entryAdded', ({ entry }) => {
    record('Log.entryAdded', entry);
    if (entry.level === 'error') errors.push(entry);
  });
  page.on('console', (message) => {
    const entry = {
      type: message.type(),
      text: message.text(),
      location: message.location(),
      timestamp: message.timestamp(),
    };
    record('Page.console', entry);
    if (entry.type === 'error') errors.push(entry);
  });
  page.on('pageerror', (error) => {
    const value = { message: error.message, stack: error.stack };
    record('Page.pageerror', value);
    errors.push(value);
  });
  page.on('request', (request) =>
    record('Page.request', { url: request.url(), method: request.method() }),
  );
  page.on('response', (response) =>
    record('Page.response', { url: response.url(), status: response.status() }),
  );
  page.on('requestfinished', (request) =>
    record('Page.requestfinished', {
      url: request.url(),
      method: request.method(),
    }),
  );
  page.on('requestfailed', (request) => {
    const entry = { url: request.url(), failure: request.failure() };
    record('Page.requestfailed', entry);
    errors.push(entry);
  });
  session.on('LayerTree.layerTreeDidChange', (event) => {
    record('LayerTree.layerTreeDidChange', event);
    layerIds = event.layers?.map((layer) => layer.layerId);
  });
  await session.send('Network.enable');
  await session.send('Log.enable');
  return {
    side,
    session,
    errors,
    cdpFailures,
    requests,
    assertClean() {
      if (errors.length || cdpFailures.length)
        throw Error('Unclassified public runtime/network outcomes remain');
    },
    async layers() {
      await session.send('Runtime.evaluate', { expression: 'void 0' });
      if (!layerIds)
        throw Error(
          'LayerTree did not provide a supported diagnostic snapshot',
        );
      return Promise.all(
        layerIds.map(async (layerId) => ({
          layerId,
          ...(await session.send('LayerTree.compositingReasons', { layerId })),
        })),
      );
    },
    terminal(url: string) {
      // Same 15s action budget as the existing panels browser file. Event-driven;
      // no sleep, polling, retry, or inferred outcome from navigation completion.
      return new Promise<void>((resolve, reject) => {
        if (closed) {
          reject(new Error('CDP already closed'));
          return;
        }
        const done = (error?: Error) => {
          clearTimeout(timer);
          waiters.delete(notify);
          cancellations.delete(cancel);
          if (error) reject(error);
          else resolve();
        };
        const cancel = () =>
          done(new Error('CDP closed before expected terminal event'));
        const notify = () => {
          const found = [...requests.values()].filter(
            (request) => request.url === url,
          );
          if (found.length > 1)
            return done(new Error('Ambiguous favicon request identity'));
          if (found.length === 1 && (found[0]!.finished || found[0]!.failure))
            done();
        };
        const timer = setTimeout(
          () =>
            done(
              new Error(
                'No exact favicon terminal event within the existing action budget',
              ),
            ),
          15_000,
        );
        waiters.add(notify);
        cancellations.add(cancel);
        notify();
      });
    },
    async flush() {
      await session.send('Runtime.evaluate', { expression: 'void 0' });
    },
    async close() {
      await session.detach();
    },
  };
}
