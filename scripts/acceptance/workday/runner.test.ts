/** Automatically collected offline regressions; no Host/browser/VM/model switch. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { browserFailure, readPage } from './browser-diagnostics.mjs';

it('runs the standard-library Python runner regression suite in ordinary CI', () => {
  execFileSync(
    'python3',
    [fileURLToPath(new URL('./run.test.py', import.meta.url)), '-v'],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    },
  );
  // execFileSync rejects nonzero status; the Python assertions are authoritative.
});

function pageFixture() {
  const locator = {
    first: () => locator,
    waitFor: vi.fn(async () => {}),
    getAttribute: vi.fn(async () => 'employee-fixture'),
  };
  const page = {
    goto: vi.fn(async () => ({ status: () => 200 })),
    url: () => 'https://fixture.invalid/readonly',
    locator: () => locator,
    getByText: () => locator,
    evaluate: vi.fn(async () => {}),
    screenshot: vi.fn(async () => {}),
  };
  const options = {
    origin: 'https://fixture.invalid',
    employeeInstanceId: 'employee-fixture',
    recipe: {
      path: '/readonly',
      locator: 'fixture',
      scopeLocator: 'fixture',
      scopeAttribute: 'fixture',
    },
    identity: vi.fn(async () => {}),
    path: '/synthetic-unit-only/never-written.png',
    screenshot: 'never-written.png',
  };
  return { page, locator, options };
}

it('keeps locator first failure and independent screenshot failure without private call logs', async () => {
  const { page, locator, options } = pageFixture();
  const timeout = new Error(
    'Cookie: private-session https://fixture.invalid/?token=secret <private-page>',
  );
  timeout.name = 'TimeoutError';
  locator.waitFor.mockRejectedValueOnce(timeout);
  page.screenshot.mockRejectedValueOnce(
    new Error('Authorization: Bearer capture-private'),
  );
  const row = await readPage(page, options);
  expect(row).toMatchObject({
    status: 'failed',
    screenshot: null,
    failure: {
      stage: 'locator',
      code: 'locator-timeout',
      type: 'TimeoutError',
    },
    captureFailure: { stage: 'capture', code: 'capture-error', type: 'Error' },
  });
  expect(row.reason).toContain('locator/locator-timeout');
  expect(row.noScreenshotReason).toContain('capture/capture-error');
  for (const secret of [
    'private-session',
    'token=secret',
    'private-page',
    'capture-private',
    '?',
  ])
    expect(JSON.stringify(row)).not.toContain(secret);
  expect(page.screenshot).toHaveBeenCalledOnce();
  expect(options.identity).toHaveBeenCalledOnce();
});

it('retains safe HTTP status and owner-binding first failure even when capture succeeds', async () => {
  for (const { error, code, status } of [
    {
      error: browserFailure('identity-http', 500),
      code: 'identity-http',
      status: 500,
    },
    {
      error: browserFailure('owner-binding-mismatch'),
      code: 'owner-binding-mismatch',
      status: undefined,
    },
  ]) {
    const { page, options } = pageFixture();
    options.identity.mockRejectedValueOnce(error);
    const row = await readPage(page, options);
    expect(row.status).toBe('failed');
    expect(row.failure).toMatchObject({
      stage: 'identity-before',
      code,
    });
    expect(row.failure.status).toBe(status);
    expect(row.screenshot).toBe('never-written.png');
    expect(row.captureFailure).toBeNull();
    expect(page.goto).not.toHaveBeenCalled();
  }
});

it('distinguishes scope failure from capture failure and rechecks identity after reads', async () => {
  const scope = pageFixture();
  scope.locator.getAttribute.mockResolvedValueOnce('foreign-employee');
  const scopeRow = await readPage(scope.page, scope.options);
  expect(scopeRow.failure).toMatchObject({
    stage: 'scope',
    code: 'scope-mismatch',
  });
  expect(scope.options.identity).toHaveBeenCalledOnce();

  const capture = pageFixture();
  capture.page.screenshot
    .mockRejectedValueOnce(new Error('private-original'))
    .mockRejectedValueOnce(new Error('private-capture'));
  const row = await readPage(capture.page, capture.options);
  expect(row.failure).toMatchObject({
    stage: 'capture',
    code: 'capture-error',
  });
  expect(row.captureFailure).toMatchObject({
    stage: 'capture',
    code: 'capture-error',
  });
  expect(capture.options.identity).toHaveBeenCalledTimes(2);
  expect(row.screenshot).toBeNull();
  expect(JSON.stringify(row)).not.toContain('private-');
});
