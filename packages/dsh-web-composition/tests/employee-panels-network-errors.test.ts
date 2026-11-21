import { describe, expect, it } from 'vitest';
import { PanelsNetworkErrors } from './employee-panels-network-errors';

const url = 'http://fixture.invalid/api/v1/workbench/files?employee=rice';
const denied =
  'Failed to load resource: the server responded with a status of 403 (Forbidden)';
const aborted = 'Failed to load resource: net::ERR_ABORTED';
function request(evidence: PanelsNetworkErrors, id: string, page = 'native') {
  const entry = { id: `${page}:${id}`, page, url, method: 'GET' };
  evidence.requests.push(entry);
  return entry;
}
function log(
  evidence: PanelsNetworkErrors,
  id: string,
  text = denied,
  timestamp = 100,
  page = 'native',
) {
  evidence.logs.push({
    page,
    source: 'network',
    level: 'error',
    text,
    timestamp,
    url,
    networkRequestId: id,
  });
  evidence.diagnostics.push({
    page,
    test: 'synthetic unit only',
    source: 'console',
    type: 'error',
    message: text,
    timestamp,
    url,
    line: 0,
    column: 0,
    args: 0,
  });
}
function deny(evidence: PanelsNetworkErrors, id: string, page = 'native') {
  const fixture = evidence.fixture(page, url, 'GET');
  evidence.deny(fixture);
  fixture.completed = true;
  fixture.status = 403;
  const entry = request(evidence, id, page);
  Object.assign(entry, { status: 403, fixtureId: fixture.id });
  return fixture;
}
function expectClean(evidence: PanelsNetworkErrors) {
  expect(evidence.audit()).toMatchObject({
    issues: [],
    unexpectedDiagnostics: [],
    unexpectedLogs: [],
    unexpectedRequests: [],
  });
}

describe('test-only network error attribution', () => {
  it('keeps raw denied evidence and classifies only the actual marked 403 request', () => {
    const evidence = new PanelsNetworkErrors();
    deny(evidence, '1');
    log(evidence, '1');
    expectClean(evidence);
    expect(evidence.audit().controlled).toEqual([
      { requestIds: ['native:1'], fixtureIds: ['fixture-0'], diagnostics: [0] },
    ]);
    expect(evidence.diagnostics).toHaveLength(1);
    expect(evidence.logs).toHaveLength(1);
  });

  it('distinguishes concurrent/repeated identical URLs by request and response identities, including reversed event order', () => {
    const evidence = new PanelsNetworkErrors();
    deny(evidence, '1');
    deny(evidence, '2');
    deny(evidence, '1', 'rev2');
    log(evidence, '2', denied, 102);
    log(evidence, '1', denied, 101);
    log(evidence, '1', denied, 101, 'rev2');
    expectClean(evidence);
    expect(
      evidence.audit().controlled.flatMap((entry) => entry.requestIds),
    ).toEqual(['native:2', 'native:1', 'rev2:1']);
  });

  it('counts a complete same-timestamp console cohort without inventing an individual request mapping', () => {
    const evidence = new PanelsNetworkErrors();
    deny(evidence, '1');
    deny(evidence, '2');
    log(evidence, '2');
    log(evidence, '1');
    expectClean(evidence);
    expect(evidence.audit().controlled).toEqual([
      {
        requestIds: ['native:2', 'native:1'],
        fixtureIds: ['fixture-1', 'fixture-0'],
        diagnostics: [0, 1],
      },
    ]);
  });

  it('blocks a nonfixture 403 even while an identical URL has a real controlled 403', () => {
    const evidence = new PanelsNetworkErrors();
    deny(evidence, '1');
    Object.assign(request(evidence, 'native-failure'), { status: 403 });
    log(evidence, '1');
    log(evidence, 'native-failure', denied, 101);
    expect(evidence.audit().controlled).toHaveLength(1);
    expect(evidence.audit().unexpectedRequests).toHaveLength(1);
    expect(evidence.audit().unexpectedDiagnostics).toHaveLength(1);
  });

  it.each(['unplanned network request', 'unmatched raw console'])(
    'blocks a same-timestamp controlled cohort contaminated by %s',
    (source) => {
      const evidence = new PanelsNetworkErrors();
      deny(evidence, '1');
      deny(evidence, '2');
      log(evidence, '1');
      log(evidence, '2');
      if (source === 'unplanned network request') {
        Object.assign(request(evidence, 'unplanned'), { status: 403 });
        log(evidence, 'unplanned');
      } else evidence.diagnostics.push({ ...evidence.diagnostics[0]! });
      expect(evidence.audit().controlled).toHaveLength(0);
      expect(evidence.audit().unexpectedDiagnostics).toHaveLength(3);
      expect(evidence.audit().unexpectedLogs.length).toBeGreaterThan(0);
    },
  );

  it.each([
    ['different text', { message: 'Native stale registration: 403' }],
    ['JavaScript console call with the same text', { args: 1 }],
    ['different timestamp at the same URL', { timestamp: 101 }],
    ['different source location at the same URL', { line: 1 }],
  ])('blocks %s rather than matching a URL/text fragment', (_name, change) => {
    const evidence = new PanelsNetworkErrors();
    deny(evidence, '1');
    log(evidence, '1');
    Object.assign(evidence.diagnostics[0]!, change);
    expect(evidence.audit().controlled).toHaveLength(0);
    expect(evidence.audit().unexpectedDiagnostics).toHaveLength(1);
    expect(evidence.audit().unexpectedLogs).toHaveLength(1);
  });

  it('never classifies pageerror/JS exceptions, even with the controlled URL and exact network text', () => {
    const evidence = new PanelsNetworkErrors();
    deny(evidence, '1');
    log(evidence, '1');
    evidence.diagnostics.push({
      ...evidence.diagnostics[0]!,
      source: 'pageerror',
    });
    expect(evidence.audit().controlled).toHaveLength(1);
    expect(evidence.audit().unexpectedDiagnostics).toMatchObject([
      { source: 'pageerror' },
    ]);
  });

  it('blocks duplicate console diagnostics instead of consuming one response twice', () => {
    const evidence = new PanelsNetworkErrors();
    deny(evidence, '1');
    log(evidence, '1');
    evidence.diagnostics.push({ ...evidence.diagnostics[0]! });
    expect(evidence.audit().controlled).toHaveLength(0);
    expect(evidence.audit().unexpectedDiagnostics).toHaveLength(2);
  });

  it('requires the planned operation, public response status and actual CDP status to agree', () => {
    for (const field of ['completed', 'status'] as const) {
      const evidence = new PanelsNetworkErrors();
      const fixture = deny(evidence, '1');
      delete fixture[field];
      log(evidence, '1');
      expect(evidence.audit().issues).toHaveLength(1);
      expect(evidence.audit().unexpectedRequests).toHaveLength(1);
    }
  });

  it.each([
    { url: url + '&other=1' },
    { method: 'POST' },
    { status: 404 },
    { page: 'other-page' },
  ])('blocks a response identity mismatch: %j', (change) => {
    const evidence = new PanelsNetworkErrors();
    deny(evidence, '1');
    Object.assign(evidence.requests[0]!, change);
    log(evidence, '1');
    expect(evidence.audit().issues).toHaveLength(1);
    expect(evidence.audit().controlled).toHaveLength(0);
    expect(evidence.audit().unexpectedDiagnostics).toHaveLength(1);
  });

  it('classifies an explicit loading-exit abort from actual request failures, without requiring Chromium to emit a console line', () => {
    const evidence = new PanelsNetworkErrors();
    const fixture = evidence.fixture('native', url, 'GET');
    fixture.held = true;
    const entry = request(evidence, '1');
    evidence.abort([fixture]);
    fixture.completed = true;
    fixture.failure = 'net::ERR_ABORTED';
    Object.assign(entry, { failure: 'net::ERR_ABORTED', canceled: true });
    expectClean(evidence);
    log(evidence, '1', aborted);
    expectClean(evidence);
  });

  it('handles concurrent same-URL aborts only when the whole in-flight cohort is held and then actually aborted', () => {
    const evidence = new PanelsNetworkErrors();
    const fixtures = [0, 1].map(() => evidence.fixture('native', url, 'GET'));
    const entries = [request(evidence, '1'), request(evidence, '2')];
    for (const fixture of fixtures) fixture.held = true;
    evidence.abort(fixtures);
    for (const fixture of fixtures)
      Object.assign(fixture, { completed: true, failure: 'net::ERR_ABORTED' });
    for (const entry of entries)
      Object.assign(entry, { failure: 'net::ERR_ABORTED', canceled: true });
    log(evidence, '2', aborted, 102);
    log(evidence, '1', aborted, 101);
    expectClean(evidence);
    expect(evidence.audit().controlled).toHaveLength(2);
  });

  it('blocks an unplanned abort with the exact same URL and ERR_ABORTED message', () => {
    const evidence = new PanelsNetworkErrors();
    Object.assign(request(evidence, 'unplanned'), {
      failure: 'net::ERR_ABORTED',
      canceled: true,
    });
    log(evidence, 'unplanned', aborted);
    expect(evidence.audit().unexpectedRequests).toHaveLength(1);
    expect(evidence.audit().unexpectedDiagnostics).toHaveLength(1);
  });

  it('fails closed when an extra concurrent request makes the loading abort cohort ambiguous', () => {
    const evidence = new PanelsNetworkErrors();
    const fixture = evidence.fixture('native', url, 'GET');
    fixture.held = true;
    const entry = request(evidence, 'planned');
    request(evidence, 'other-concurrent-request');
    evidence.abort([fixture]);
    fixture.completed = true;
    fixture.failure = 'net::ERR_ABORTED';
    Object.assign(entry, { failure: 'net::ERR_ABORTED', canceled: true });
    log(evidence, 'planned', aborted);
    expect(evidence.audit().issues.length).toBeGreaterThan(0);
    expect(evidence.audit().controlled).toHaveLength(0);
    expect(evidence.audit().unexpectedRequests).toHaveLength(1);
  });

  it('rejects a planned abort with a different failure reason or a missing actual cancellation', () => {
    for (const actual of [
      { failure: 'net::ERR_FAILED', canceled: true },
      { failure: 'net::ERR_ABORTED', canceled: false },
    ]) {
      const evidence = new PanelsNetworkErrors();
      const fixture = evidence.fixture('native', url, 'GET');
      fixture.held = true;
      const entry = request(evidence, '1');
      evidence.abort([fixture]);
      fixture.completed = true;
      fixture.failure = 'net::ERR_ABORTED';
      Object.assign(entry, actual);
      log(evidence, '1', aborted);
      expect(evidence.audit().unexpectedRequests).toHaveLength(1);
      expect(evidence.audit().unexpectedDiagnostics).toHaveLength(1);
    }
  });
});
