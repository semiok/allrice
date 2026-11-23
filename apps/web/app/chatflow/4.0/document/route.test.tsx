import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GET } from './route';
import EntryPage from '../page';
import { DataAccessError } from '@allrice/database';

const authenticated = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/identity/session', () => ({
  requireRequestContext: authenticated,
}));
vi.mock('@allrice/database', () => ({
  DataAccessError: class extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
  CodexSubscriptionError: class extends Error {},
}));

const selection = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  employeeInstanceId: '00000000-0000-4000-8000-000000000002',
};
const query = new URLSearchParams(selection).toString();
const request = (suffix = query) =>
  new Request(`https://allrice.test/chatflow/4.0/document?${suffix}`, {
    headers: {
      cookie: 'allrice_session=unit-test-session',
      // Neither a caller's owner claim nor a fixture flag can install a carrier.
      'x-allrice-owner': 'true',
      'x-allrice-fixture': 'enabled',
    },
  });
beforeEach(() => {
  authenticated.mockReset();
  authenticated.mockResolvedValue({ actor: { type: 'user', id: 'actor' } });
});

it('the Next product page targets only the fixed same-origin document, preserving selectors', async () => {
  const page = await EntryPage({ searchParams: Promise.resolve(selection) });
  const html = renderToStaticMarkup(page);
  expect(html).toContain('src="/chatflow/4.0/document?');
  expect(html).toContain('workspaceId=');
  expect(html).not.toContain('native-owner');
  expect(html).not.toContain('<script');
  const response = await GET(request());
  expect(response.status).toBe(503);
});

it('checks the original Request/Cookie before accepting even invalid selectors', async () => {
  authenticated.mockRejectedValueOnce(
    new DataAccessError('authentication_required'),
  );
  const original = request('owner=true');
  const response = await GET(original);
  expect(authenticated).toHaveBeenCalledExactlyOnceWith(original);
  expect(response.status).toBe(401);
  expect((await response.json()).error.code).toBe('AUTHENTICATION_REQUIRED');
});

it.each([
  '',
  `${query}&workspaceId=${selection.workspaceId}`,
  `${query}&principal=owner`,
  `${query}&generation=4.0`,
  `${query}&nativeSessionId=not-an-authority`,
])(
  'rejects missing, duplicate or caller-supplied authority selectors: %s',
  async (suffix) => {
    const response = await GET(request(suffix));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION_FAILED');
  },
);

it('cannot turn build identity, browser headers or fixture input into an executable document', async () => {
  const response = await GET(request());
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  const body = await response.text();
  expect(JSON.parse(body).error).toMatchObject({
    code: 'DEPENDENCY_UNAVAILABLE',
    retryable: false,
  });
  expect(body).not.toMatch(/<script|__DSH_|owner|grants|native-owner/);
});

it('preserves invalid empty/duplicate values on the page for the document parser', async () => {
  const html = renderToStaticMarkup(
    await EntryPage({
      searchParams: Promise.resolve({
        ...selection,
        principal: '',
        threadId: ['a', 'b'],
      }),
    }),
  );
  expect(html).toContain('principal=');
  expect(html).toContain('threadId=a');
  expect(html).toContain('threadId=b');
});
