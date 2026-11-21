import type { Page, Request } from 'playwright-core';

export const fixtureFailureHeader = 'x-allrice-panels-fixture-failure';
export const fixtureAbortCode = 'aborted';
const deniedText =
  'Failed to load resource: the server responded with a status of 403 (Forbidden)';
const abortedText = 'Failed to load resource: net::ERR_ABORTED';
type FixtureRequest = {
  id: string;
  page: string;
  url: string;
  method: string;
  held: boolean;
  plan?: 'denied' | 'loading-exit';
  abortCode?: typeof fixtureAbortCode;
  completed?: boolean;
  status?: number;
  failure?: string;
};
type NetworkRequest = {
  id: string;
  page: string;
  url: string;
  method: string;
  status?: number;
  fixtureId?: string;
  failure?: string;
  canceled?: boolean;
  finished?: boolean;
  abortFixtures?: string[];
};
type Diagnostic = {
  page: string;
  test: string | null;
  source: 'console' | 'pageerror';
  message: string;
  type?: string;
  timestamp?: number;
  url?: string;
  line?: number;
  column?: number;
  args?: number;
  stack?: string;
};
type NetworkLog = {
  page: string;
  source: string;
  level: string;
  text: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
  networkRequestId?: string;
};

/** Test evidence only. All raw arrays are append-only; no console text filter.
 * A network log needs CDP request identity AND a completed fixture operation.
 * Aborts with identical URLs are authorized as a complete in-flight cohort;
 * any extra/missing request makes that cohort ambiguous and stays blocking. */
export class PanelsNetworkErrors {
  readonly diagnostics: Diagnostic[] = [];
  readonly fixtures: FixtureRequest[] = [];
  readonly requests: NetworkRequest[] = [];
  readonly logs: NetworkLog[] = [];
  readonly issues: string[] = [];

  fixture(page: string, url: string, method: string) {
    const request: FixtureRequest = {
      id: `fixture-${this.fixtures.length}`,
      page,
      url,
      method,
      held: false,
    };
    this.fixtures.push(request);
    return request;
  }

  deny(request: FixtureRequest) {
    if (
      request.method !== 'GET' ||
      !['/api/v1/references/publications', '/api/v1/workbench/files'].includes(
        new URL(request.url).pathname,
      )
    )
      throw Error(
        'Only the two explicit read-only denied catalogs are controlled',
      );
    request.plan = 'denied';
    return { [fixtureFailureHeader]: request.id };
  }

  abort(requests: FixtureRequest[]) {
    const groups = new Map<string, FixtureRequest[]>();
    for (const request of requests) {
      request.plan = 'loading-exit';
      request.abortCode = fixtureAbortCode;
      const key = JSON.stringify([request.page, request.url, request.method]);
      groups.set(key, [...(groups.get(key) ?? []), request]);
    }
    for (const group of groups.values()) {
      const first = group[0]!;
      const active = this.requests.filter(
        (request) =>
          request.page === first.page &&
          request.url === first.url &&
          request.method === first.method &&
          request.status === undefined &&
          !request.failure &&
          !request.finished &&
          !request.abortFixtures,
      );
      if (
        active.length !== group.length ||
        group.some((request) => !request.held)
      ) {
        this.issues.push(
          `Ambiguous loading-exit cohort: ${JSON.stringify({ group, active })}`,
        );
        continue;
      }
      for (const request of active)
        request.abortFixtures = group.map((entry) => entry.id);
    }
  }

  audit() {
    const issues = [...this.issues];
    const controlledRequests = new Set<string>();
    for (const request of this.requests) {
      if (
        this.requests.filter((entry) => entry.id === request.id).length !== 1
      ) {
        if (request.fixtureId || request.abortFixtures)
          issues.push(
            `Ambiguous redirected/duplicate request identity: ${request.id}`,
          );
        continue;
      }
      const fixture = this.fixtures.find(
        (entry) => entry.id === request.fixtureId,
      );
      if (
        fixture?.plan === 'denied' &&
        fixture.completed &&
        fixture.status === 403 &&
        fixture.page === request.page &&
        fixture.url === request.url &&
        fixture.method === request.method &&
        request.status === 403 &&
        !request.failure
      )
        controlledRequests.add(request.id);
      if (request.abortFixtures) {
        const cohort = this.fixtures.filter((entry) =>
          request.abortFixtures!.includes(entry.id),
        );
        if (
          cohort.length === request.abortFixtures.length &&
          cohort.every(
            (entry) =>
              entry.plan === 'loading-exit' &&
              entry.abortCode === fixtureAbortCode &&
              entry.completed &&
              entry.failure === 'net::ERR_ABORTED',
          ) &&
          request.status === undefined &&
          request.failure === 'net::ERR_ABORTED' &&
          request.canceled === true
        )
          controlledRequests.add(request.id);
      }
    }
    for (const fixture of this.fixtures.filter((entry) => entry.plan)) {
      const matches = this.requests.filter(
        (request) =>
          controlledRequests.has(request.id) &&
          (fixture.plan === 'denied'
            ? request.fixtureId === fixture.id
            : request.abortFixtures?.includes(fixture.id)),
      );
      const count =
        fixture.plan === 'denied' ? 1 : matches[0]?.abortFixtures?.length;
      if (!fixture.completed || !count || matches.length !== count)
        issues.push(`Missing/ambiguous actual fixture outcome: ${fixture.id}`);
    }
    const controlled: {
      requestIds: string[];
      fixtureIds: string[];
      diagnostics: number[];
    }[] = [];
    const consumed = new Set<number>();
    const logged = new Set<string>();
    const unexpectedLogs: NetworkLog[] = [];
    const groups = new Map<string, NetworkLog[]>();
    for (const log of this.logs.filter((entry) => entry.level === 'error')) {
      const key = JSON.stringify([
        log.page,
        log.timestamp,
        log.url,
        log.text,
        log.lineNumber ?? 0,
      ]);
      groups.set(key, [...(groups.get(key) ?? []), log]);
    }
    for (const logs of groups.values()) {
      const log = logs[0]!;
      const requests = logs.map((entry) =>
        this.requests.find(
          (request) => request.id === `${entry.page}:${entry.networkRequestId}`,
        ),
      );
      const candidates = this.diagnostics.flatMap((entry, index) =>
        entry.source === 'console' &&
        entry.type === 'error' &&
        entry.page === log.page &&
        entry.timestamp === log.timestamp &&
        entry.message === log.text &&
        entry.url === log.url &&
        entry.line === (log.lineNumber ?? 0) &&
        entry.column === 0 &&
        entry.args === 0 &&
        !consumed.has(index)
          ? [index]
          : [],
      );
      if (
        candidates.length !== logs.length ||
        new Set(requests.map((request) => request?.id)).size !== logs.length ||
        requests.some(
          (request, index) =>
            !request ||
            !controlledRequests.has(request.id) ||
            logged.has(request.id) ||
            logs[index]!.source !== 'network' ||
            log.url !== request.url ||
            log.text !== (request.status === 403 ? deniedText : abortedText),
        )
      ) {
        unexpectedLogs.push(...logs);
        continue;
      }
      // Same timestamp/URL/text can be indistinguishable in public console
      // events. Keep the complete, count-checked cohort instead of inventing
      // a one-to-one mapping or consuming an arbitrary native/JS error.
      for (const request of requests) logged.add(request!.id);
      for (const index of candidates) consumed.add(index);
      controlled.push({
        requestIds: requests.map((request) => request!.id),
        fixtureIds: [
          ...new Set(
            requests.flatMap((request) =>
              request!.fixtureId
                ? [request!.fixtureId]
                : request!.abortFixtures!,
            ),
          ),
        ],
        diagnostics: candidates,
      });
    }
    return {
      controlled,
      issues,
      unexpectedLogs,
      unexpectedRequests: this.requests.filter(
        (request) =>
          ((request.status ?? 0) >= 400 || request.failure) &&
          !controlledRequests.has(request.id),
      ),
      unexpectedDiagnostics: this.diagnostics.filter(
        (entry, index) =>
          (entry.source === 'pageerror' || entry.type === 'error') &&
          !consumed.has(index),
      ),
    };
  }
}

/** Public Playwright/CDP observation; no private Request fields or interception. */
export async function observePanelsNetwork(
  page: Page,
  id: string,
  test: string | null,
  evidence: PanelsNetworkErrors,
) {
  const session = await page.context().newCDPSession(page);
  const fixtures = new WeakMap<Request, FixtureRequest>();
  const request = (key: string) =>
    evidence.requests.find((entry) => entry.id === `${id}:${key}`);
  session.on('Network.requestWillBeSent', (event) => {
    evidence.requests.push({
      id: `${id}:${event.requestId}`,
      page: id,
      url: event.request.url,
      method: event.request.method,
    });
  });
  session.on('Network.responseReceived', (event) => {
    const entry = request(event.requestId);
    if (!entry) return;
    entry.status = event.response.status;
    entry.fixtureId = Object.entries(event.response.headers).find(
      ([name]) => name.toLowerCase() === fixtureFailureHeader,
    )?.[1];
  });
  session.on('Network.loadingFailed', (event) => {
    const entry = request(event.requestId);
    if (entry)
      Object.assign(entry, {
        failure: event.errorText,
        canceled: event.canceled,
      });
    else
      evidence.issues.push(
        `Unmatched CDP failure: ${id}:${event.requestId}: ${event.errorText}`,
      );
  });
  session.on('Network.loadingFinished', (event) => {
    const entry = request(event.requestId);
    if (entry) entry.finished = true;
  });
  session.on('Log.entryAdded', ({ entry }) =>
    evidence.logs.push({ ...entry, page: id }),
  );
  page.on('console', (message) =>
    evidence.diagnostics.push({
      page: id,
      test,
      source: 'console',
      type: message.type(),
      message: message.text(),
      timestamp: message.timestamp(),
      url: message.location().url,
      line: message.location().line,
      column: message.location().column,
      args: message.args().length,
    }),
  );
  page.on('pageerror', (error) =>
    evidence.diagnostics.push({
      page: id,
      test,
      source: 'pageerror',
      message: error.message,
      stack: error.stack,
    }),
  );
  page.on('response', (response) => {
    const entry = fixtures.get(response.request());
    if (entry) entry.status = response.status();
  });
  page.on('requestfailed', (failed) => {
    const entry = fixtures.get(failed);
    if (entry) entry.failure = failed.failure()?.errorText;
  });
  await session.send('Network.enable');
  await session.send('Log.enable');
  let closed = false;
  session.on('close', () => {
    closed = true;
  });
  return {
    fixture(request: Request) {
      const entry = evidence.fixture(id, request.url(), request.method());
      fixtures.set(request, entry);
      return entry;
    },
    async flush() {
      // A protocol round trip drains earlier events; no sleep/retry/timeout change.
      if (!closed)
        await session.send('Runtime.evaluate', { expression: 'void 0' });
    },
  };
}
