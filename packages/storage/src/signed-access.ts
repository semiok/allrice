import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  SignedAccessGrantSchema,
  type StorageObject,
} from '@allrice/contracts';

export class SignedAccessError extends Error {}

function signature(secret: string, payload: string) {
  return createHmac('sha256', secret).update(payload).digest();
}

export class SignedAccessService {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32) {
      throw new Error('storage signing secret must contain at least 32 bytes');
    }
  }

  issue(input: {
    object: StorageObject;
    subjectId: string;
    operation: 'read' | 'write';
    lifetimeSeconds?: number;
  }) {
    const lifetimeSeconds = input.lifetimeSeconds ?? 300;
    if (lifetimeSeconds < 1 || lifetimeSeconds > 900) {
      throw new SignedAccessError(
        'signed access lifetime must be 1-900 seconds',
      );
    }
    const grant = SignedAccessGrantSchema.parse({
      objectId: input.object.id,
      subjectId: input.subjectId,
      operation: input.operation,
      expiresAt: new Date(Date.now() + lifetimeSeconds * 1000).toISOString(),
      nonce: randomUUID(),
    });
    const payload = Buffer.from(JSON.stringify(grant), 'utf8').toString(
      'base64url',
    );
    return {
      grant,
      token: `${payload}.${signature(this.secret, payload).toString('base64url')}`,
    };
  }

  verify(
    token: string,
    expected: { objectId: string; operation: 'read' | 'write' },
  ) {
    const [payload, encodedSignature, extra] = token.split('.');
    if (!payload || !encodedSignature || extra) {
      throw new SignedAccessError('signed access token is malformed');
    }
    const actual = Buffer.from(encodedSignature, 'base64url');
    const expectedSignature = signature(this.secret, payload);
    if (
      actual.length !== expectedSignature.length ||
      !timingSafeEqual(actual, expectedSignature)
    ) {
      throw new SignedAccessError('signed access signature is invalid');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new SignedAccessError('signed access payload is invalid');
    }
    const grant = SignedAccessGrantSchema.parse(decoded);
    if (
      grant.objectId !== expected.objectId ||
      grant.operation !== expected.operation
    ) {
      throw new SignedAccessError('signed access scope does not match request');
    }
    if (Date.parse(grant.expiresAt) <= Date.now()) {
      throw new SignedAccessError('signed access token has expired');
    }
    return grant;
  }
}
