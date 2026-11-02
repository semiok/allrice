import { afterEach, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import {
  requestNativeRunDiagnostics,
  requestNativeSubagentSummary,
  requestNativeSubagentFollow,
} from './native-run-diagnostics';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const runId = '11111111-1111-4111-8111-111111111111';
const input = {
  token: 'real_session_token',
  context: {
    organizationId: '22222222-2222-4222-8222-222222222222',
  } as RequestContext,
  workspaceId: '33333333-3333-4333-8333-333333333333',
  runId,
  signal: new AbortController().signal,
};
const report = {
  schemaVersion: 1,
  runId,
  observedAt: '2026-10-24T00:00:00Z',
  source: 'native_persisted_journal',
  clock: 'native_wall_clock_epoch_ms',
  providerWire: null,
  status: 'unavailable',
  reasons: ['source_receipts_missing'],
  slices: [],
};
it('uses the fixed Worker address, a real bearer, no redirects/cache, and identity-only input', async () => {
  vi.stubEnv('ALLRICE_WORKER_INTERNAL_URL', 'http://worker:3101');
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json({ diagnostics: report }));
  vi.stubGlobal('fetch', fetch);
  expect(await requestNativeRunDiagnostics(input)).toEqual(report);
  expect(fetch).toHaveBeenCalledWith(
    new URL('http://worker:3101/internal/native-run-diagnostics'),
    expect.objectContaining({
      method: 'POST',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.token}`,
      },
      body: JSON.stringify({
        runId,
        organizationId: input.context.organizationId,
        workspaceId: input.workspaceId,
      }),
    }),
  );
});
it('rejects unexpected Run/fields and masks remote bodies without exposing them', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ diagnostics: { ...report, runId: input.workspaceId } }),
    );
  vi.stubGlobal('fetch', fetch);
  await expect(requestNativeRunDiagnostics(input)).rejects.toMatchObject({
    status: 503,
    message: 'Native diagnostics unavailable',
  });
  fetch.mockResolvedValue(
    Response.json({ diagnostics: { ...report, credentials: 'secret' } }),
  );
  await expect(requestNativeRunDiagnostics(input)).rejects.toMatchObject({
    status: 503,
  });
  fetch.mockResolvedValue(
    new Response('private failure detail', { status: 500 }),
  );
  await expect(requestNativeRunDiagnostics(input)).rejects.toMatchObject({
    status: 503,
    message: 'Native diagnostics unavailable',
  });
});

it('uses the same fixed authenticated transport for a business Session without diagnostic limits', async () => {
  vi.stubEnv('ALLRICE_WORKER_INTERNAL_URL', 'http://worker:3101');
  const summary = {
    rootId: 'dsh-root',
    root: { source: 'prepared', cursor: -1 },
    descendants: [],
  };
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json({ sessionId: runId, summary }));
  vi.stubGlobal('fetch', fetch);
  expect(
    await requestNativeSubagentSummary({ ...input, sessionId: runId }),
  ).toEqual(summary);
  expect(fetch).toHaveBeenCalledWith(
    new URL('http://worker:3101/internal/native-subagent-summary'),
    expect.objectContaining({
      signal: input.signal,
      cache: 'no-store',
      redirect: 'error',
      body: JSON.stringify({
        sessionId: runId,
        organizationId: input.context.organizationId,
        workspaceId: input.workspaceId,
      }),
    }),
  );
});

it('refuses a mismatched Session envelope or malformed summary without exposing remote bodies', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ sessionId: input.workspaceId, summary: {} }),
    );
  vi.stubGlobal('fetch', fetch);
  await expect(
    requestNativeSubagentSummary({ ...input, sessionId: runId }),
  ).rejects.toMatchObject({ status: 503 });
  fetch.mockResolvedValue(
    Response.json({ sessionId: runId, summary: { private: 'secret' } }),
  );
  await expect(
    requestNativeSubagentSummary({ ...input, sessionId: runId }),
  ).rejects.toMatchObject({ status: 503 });
});

it.each(['transport', 'worker_status', 'decode'])(
  'logs a fixed %s category and Session address without credentials or remote failures',
  async (phase) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const secret = `${input.token} Bearer private-header /private/tenant/user-content`;
    const fetch = vi.fn();
    if (phase === 'transport') fetch.mockRejectedValue(Error(secret));
    else
      fetch.mockResolvedValue(
        new Response(secret, { status: phase === 'decode' ? 200 : 503 }),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(
      requestNativeSubagentSummary({
        ...input,
        sessionId: runId,
        liveOnly: true,
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: 'Native diagnostics unavailable',
    });
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'Native diagnostics request failed',
      {
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
        targetId: runId,
        liveOnly: true,
        follow: false,
        phase,
        workerStatus:
          phase === 'transport' ? undefined : phase === 'decode' ? 200 : 503,
      },
    );
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(
      /real_session_token|Bearer|private-header|\/private|user-content/,
    );
  },
);

it.each([401, 404, 429, 500, 503])(
  'keeps the Worker %s mapping while logging only its status',
  async (status) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('private Worker error', { status })),
    );
    await expect(
      requestNativeSubagentSummary({ ...input, sessionId: runId }),
    ).rejects.toMatchObject({
      status: [401, 404].includes(status) ? status : 503,
    });
    expect(warning).toHaveBeenCalledWith(
      'Native diagnostics request failed',
      expect.objectContaining({ phase: 'worker_status', workerStatus: status }),
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      'private Worker error',
    );
  },
);

it('classifies an invalid follow envelope without exposing its body or changing the error', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ secret: input.token })),
  );
  await expect(
    requestNativeSubagentFollow({ ...input, sessionId: runId }),
  ).rejects.toMatchObject({ status: 503 });
  expect(warning).toHaveBeenCalledWith(
    'Native diagnostics request failed',
    expect.objectContaining({
      follow: true,
      phase: 'decode',
      workerStatus: 200,
    }),
  );
  expect(JSON.stringify(warning.mock.calls)).not.toContain(input.token);
});
