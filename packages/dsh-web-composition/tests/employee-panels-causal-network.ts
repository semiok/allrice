import type { Page } from 'playwright-core';

export const causalReplayOrigin = 'http://allrice-panels-causal-replay.invalid';
export type CausalReplayRegistration = {
  id: string;
  origin: typeof causalReplayOrigin;
  navigationUrl: string;
  method: 'GET';
  bodySha256: string;
};

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

/** Diagnostic A only: B proved this CDP-only tool cancellation. Every receipt,
 * request and raw failure remains append-only. This is not the panels UI audit. */
export function auditCausalToolControl(
  events: ReturnType<typeof causalJournal>['events'],
  side: string,
) {
  const own = events.filter((event) => event.side === side);
  type Data = Partial<CausalReplayRegistration> & {
    requestId?: string;
    loaderId?: string;
    frameId?: string;
    documentURL?: string;
    type?: string;
    redirectResponse?: unknown;
    status?: number;
    mainFrame?: boolean;
    request?: {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
    };
    response?: {
      url?: string;
      status?: number;
      headers?: Record<string, string>;
    };
    initiator?: { type?: string };
    timestamp?: number;
    errorText?: string;
    canceled?: boolean;
    blockedReason?: unknown;
    corsErrorStatus?: unknown;
    url?: string;
  };
  const named = (name: string) => own.filter((event) => event.name === name);
  const data = (event: (typeof own)[number]) => event.data as Data;
  const registrations = named('replay-registration');
  const controlledFailures: unknown[] = [],
    issues: string[] = [];
  if (!registrations.length) return { controlledFailures, issues };
  const reject = () => {
    issues.push('Trusted replay tool-control chain is incomplete or ambiguous');
    return { controlledFailures, issues };
  };
  if (side !== 'reference' || registrations.length !== 1) return reject();
  const registration = registrations[0]!,
    r = data(registration);
  let navigation: URL;
  try {
    navigation = new URL(r.navigationUrl!);
  } catch {
    return reject();
  }
  if (
    r.origin !== causalReplayOrigin ||
    navigation.origin !== causalReplayOrigin ||
    navigation.pathname !== '/' ||
    navigation.username ||
    navigation.password ||
    navigation.hash ||
    r.method !== 'GET' ||
    !r.id ||
    !/^[a-f0-9]{64}$/.test(r.bodySha256 ?? '')
  )
    return reject();
  const starts = named('Network.requestWillBeSent');
  const docs = starts.filter(
    (event) => data(event).request?.url === r.navigationUrl,
  );
  const icons = starts.filter(
    (event) => data(event).request?.url === r.origin + '/favicon.ico',
  );
  if (starts.length !== 2 || docs.length !== 1 || icons.length !== 1)
    return reject();
  const doc = docs[0]!,
    icon = icons[0]!,
    d = data(doc),
    i = data(icon);
  if (
    !d.requestId ||
    d.requestId === i.requestId ||
    d.requestId !== d.loaderId ||
    !d.frameId ||
    d.type !== 'Document' ||
    d.documentURL !== r.navigationUrl ||
    d.request?.method !== 'GET' ||
    d.redirectResponse !== undefined ||
    !i.requestId ||
    i.type !== 'Other' ||
    i.documentURL !== r.navigationUrl ||
    i.request?.method !== 'GET' ||
    i.request.headers?.Referer !== r.navigationUrl ||
    i.initiator?.type !== 'other' ||
    i.loaderId !== d.loaderId ||
    i.frameId !== d.frameId ||
    i.redirectResponse !== undefined
  )
    return reject();
  const terminal = (name: string, id: string) =>
    named(name).filter((event) => data(event).requestId === id);
  const responses = terminal('Network.responseReceived', d.requestId);
  const finished = terminal('Network.loadingFinished', d.requestId);
  const failed = terminal('Network.loadingFailed', i.requestId);
  const entries = named('route-entry'),
    issued = named('route-fulfill-issued'),
    completed = named('route-fulfilled'),
    navigations = named('replay-navigation-complete');
  if (
    responses.length !== 1 ||
    finished.length !== 1 ||
    failed.length !== 1 ||
    terminal('Network.loadingFailed', d.requestId).length ||
    terminal('Network.responseReceived', i.requestId).length ||
    terminal('Network.loadingFinished', i.requestId).length ||
    entries.length !== 1 ||
    issued.length !== 1 ||
    completed.length !== 1 ||
    navigations.length !== 1
  )
    return reject();
  const response = responses[0]!,
    end = finished[0]!,
    failure = failed[0]!,
    f = data(failure),
    responseData = data(response);
  for (const receipt of [
    entries[0]!,
    issued[0]!,
    completed[0]!,
    navigations[0]!,
  ]) {
    const value = data(receipt);
    if (
      value.id !== r.id ||
      value.url !== r.navigationUrl ||
      value.method !== 'GET' ||
      value.bodySha256 !== r.bodySha256
    )
      return reject();
  }
  if (
    data(issued[0]!).status !== 200 ||
    data(completed[0]!).status !== 200 ||
    data(navigations[0]!).status !== 200 ||
    data(navigations[0]!).mainFrame !== true ||
    responseData.type !== 'Document' ||
    responseData.loaderId !== d.loaderId ||
    responseData.frameId !== d.frameId ||
    responseData.response?.url !== r.navigationUrl ||
    responseData.response?.status !== 200 ||
    responseData.response?.headers?.['x-allrice-causal-replay'] !== r.id ||
    f.type !== 'Other' ||
    f.errorText !== 'net::ERR_ABORTED' ||
    f.canceled !== true ||
    f.blockedReason !== undefined ||
    f.corsErrorStatus !== undefined ||
    typeof i.timestamp !== 'number' ||
    typeof f.timestamp !== 'number' ||
    f.timestamp < i.timestamp ||
    ![
      registration.seq,
      doc.seq,
      entries[0]!.seq,
      issued[0]!.seq,
      response.seq,
      end.seq,
      icon.seq,
      failure.seq,
    ].every((seq, index, list) => index === 0 || seq > list[index - 1]!) ||
    completed[0]!.seq <= issued[0]!.seq ||
    navigations[0]!.seq <= issued[0]!.seq ||
    own.some(
      (event) =>
        event.name.startsWith('Page.') &&
        data(event).url === r.origin + '/favicon.ico',
    )
  )
    return reject();
  controlledFailures.push(failure.data);
  return { controlledFailures, issues };
}

/** Passive public events; only explicitly registered diagnostic replay can classify. */
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
  const audit = () => {
    const control = auditCausalToolControl(journal.events, side);
    return {
      ...control,
      publicErrors: errors,
      rawCdpFailures: cdpFailures,
      unknownCdpFailures: cdpFailures.filter(
        (failure) => !control.controlledFailures.includes(failure),
      ),
    };
  };
  return {
    side,
    session,
    errors,
    cdpFailures,
    requests,
    audit,
    assertClean() {
      const value = audit();
      if (
        errors.length ||
        value.issues.length ||
        value.unknownCdpFailures.length
      )
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
