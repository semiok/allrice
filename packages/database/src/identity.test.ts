import { describe, expect, it } from 'vitest';

import { hashOpaqueToken, hashPassword, verifyPassword } from './identity.ts';

describe('identity secrets', () => {
  it('stores a versioned scrypt password hash and verifies it', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    expect(encoded).toMatch(/^scrypt\$/);
    expect(encoded).not.toContain('correct horse battery staple');
    await expect(
      verifyPassword('correct horse battery staple', encoded),
    ).resolves.toBe(true);
    await expect(verifyPassword('not the password', encoded)).resolves.toBe(
      false,
    );
  });

  it('hashes invitation and session tokens before persistence', () => {
    const token = 'a'.repeat(43);
    expect(hashOpaqueToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOpaqueToken(token)).not.toContain(token);
  });
});
