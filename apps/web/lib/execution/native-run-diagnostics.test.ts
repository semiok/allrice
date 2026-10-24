import { afterEach, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import { requestNativeRunDiagnostics } from './native-run-diagnostics';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
