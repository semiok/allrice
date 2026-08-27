import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { PortalDefinition } from './config';

export const portalSessionCookieName = 'allrice_portal_session';

const lifetimeSeconds = 7 * 24 * 60 * 60;

export interface PortalSession {
  version: 1;
  portalKey: PortalDefinition['key'];
  subject: string;
  organizationId: string;
  workspaceId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

function sessionSecret() {
  const secret = process.env.ALLRICE_PORTAL_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'ALLRICE_PORTAL_SESSION_SECRET must contain at least 32 characters',
    );
  }
  return secret;
}

function sign(encoded: string) {
  return createHmac('sha256', sessionSecret())
    .update(encoded, 'utf8')
    .digest('base64url');
}

function constantTimeEqual(left: string, right: string) {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyPortalCredentials(
  portal: PortalDefinition,
  username: unknown,
  password: unknown,
) {
  if (typeof username !== 'string' || typeof password !== 'string')
    return false;
  const expectedPassword = process.env[portal.passwordEnvironmentVariable];
  if (!expectedPassword) return false;
  return (
    constantTimeEqual(username, portal.username) &&
    constantTimeEqual(password, expectedPassword)
  );
}

export function createPortalSession(input: {
  portal: PortalDefinition;
  subject: string;
  organizationId: string;
  workspaceId: string;
}) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: PortalSession = {
    version: 1,
    portalKey: input.portal.key,
    subject: input.subject,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    issuedAt,
    expiresAt: issuedAt + lifetimeSeconds,
    nonce: randomBytes(12).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  return {
    value: `${encoded}.${sign(encoded)}`,
    expiresAt: new Date(payload.expiresAt * 1000),
  };
}

export function verifyPortalSession(
  value: string | undefined,
  portal: PortalDefinition,
) {
  if (!value) return null;
  const [encoded, signature, extra] = value.split('.');
  if (!encoded || !signature || extra) return null;
  if (!constantTimeEqual(signature, sign(encoded))) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<PortalSession>;
    if (
      payload.version !== 1 ||
      payload.portalKey !== portal.key ||
      typeof payload.subject !== 'string' ||
      typeof payload.organizationId !== 'string' ||
      typeof payload.workspaceId !== 'string' ||
      typeof payload.issuedAt !== 'number' ||
      typeof payload.expiresAt !== 'number' ||
      typeof payload.nonce !== 'string' ||
      payload.expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload as PortalSession;
  } catch {
    return null;
  }
}

export const portalSessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure:
    process.env.NODE_ENV === 'production' &&
    process.env.ALLRICE_PORTAL_SECURE_COOKIE !== '0',
  path: '/',
};
