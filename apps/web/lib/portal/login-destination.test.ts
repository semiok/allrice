import { expect, it } from 'vitest';
import { loginDestination } from './login-destination';
it('preserves a tenant employee trial link without accepting external redirects', () => {
  const origin = 'https://allrice-snow.bplabs.xyz';
  expect(
    loginDestination('/chatflow?employee=selected', '/chatflow', origin, false),
  ).toBe('/chatflow?employee=selected');
  for (const next of [
    'https://evil.test/chatflow',
    '//evil.test/chatflow',
    '/api/v1/auth/logout',
    null,
  ]) {
    expect(loginDestination(next, '/chatflow', origin, false)).toBe(
      '/chatflow',
    );
  }
});

it('keeps employee deep links on the employee login', () => {
  for (const next of [
    '/workspace/mcp?connectionId=kept',
    '/chatflow?session=kept',
  ])
    expect(
      loginDestination(next, '/chatflow', 'https://allrice.bplabs.xyz', true),
    ).toBe(next);
});

it('keeps admin deep links only on the admin entry', () => {
  const next = '/runtime-console?view=activity&organizationId=kept';
  // The server says which entry the page is; a deployment's own domain counts.
  for (const origin of ['https://allrice.bplabs.xyz', 'https://a.bplabs.xyz'])
    expect(loginDestination(next, '/chatflow', origin, true)).toBe('/chatflow');
  expect(
    loginDestination(
      next,
      '/runtime-console',
      'https://allrice-admin.bplabs.xyz',
      false,
    ),
  ).toBe(next);
});
