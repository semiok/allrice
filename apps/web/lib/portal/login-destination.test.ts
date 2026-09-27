import { expect, it } from 'vitest';
import { loginDestination } from './login-destination';
it('preserves a tenant employee trial link without accepting external redirects', () => {
  const origin = 'https://allrice-snow.bplabs.xyz';
  expect(
    loginDestination('/chatflow?employee=selected', '/chatflow', origin),
  ).toBe('/chatflow?employee=selected');
  for (const next of [
    'https://evil.test/chatflow',
    '//evil.test/chatflow',
    '/api/v1/auth/logout',
    null,
  ]) {
    expect(loginDestination(next, '/chatflow', origin)).toBe('/chatflow');
  }
});

it('keeps company, application and admin deep links through login', () => {
  for (const next of [
    '/runtime-console?view=activity&organizationId=kept',
    '/workspace/mcp?connectionId=kept',
    '/chatflow?session=kept',
  ])
    expect(
      loginDestination(next, '/chatflow', 'https://allrice.bplabs.xyz'),
    ).toBe(next);
});
