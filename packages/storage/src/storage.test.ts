import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeObjectKey, type StorageObject } from '@allrice/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalStorageAdapter } from './local.ts';
import { SignedAccessError, SignedAccessService } from './signed-access.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

function fixture(content: Uint8Array) {
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const id = randomUUID();
  const object: StorageObject = {
    id,
    organizationId,
    workspaceId,
    ownerId,
    key: makeObjectKey({
      organizationId,
      workspaceId,
      ownerId,
      category: 'uploads',
      objectId: id,
    }),
    checksum: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    mediaType: 'text/plain',
    sizeBytes: content.byteLength,
    retentionUntil: null,
    deletedAt: null,
    immutable: false,
  };
  return object;
}

describe('local storage adapter', () => {
  it('persists content across adapter restarts and verifies integrity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-storage-'));
    roots.push(root);
    const content = new TextEncoder().encode('persistent rice');
    const object = fixture(content);
    await new LocalStorageAdapter(root).put(
      object,
      new Blob([content]).stream(),
    );
    const restarted = new LocalStorageAdapter(root);
    expect(await restarted.exists(object)).toBe(true);
    expect(await new Response(await restarted.get(object)).text()).toBe(
      'persistent rice',
    );
  });

  it('rejects content whose declared checksum does not match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-storage-'));
    roots.push(root);
    const content = new TextEncoder().encode('tampered');
    const object = {
      ...fixture(content),
      checksum: `sha256:${'0'.repeat(64)}`,
    };
    await expect(
      new LocalStorageAdapter(root).put(object, new Blob([content]).stream()),
    ).rejects.toThrow('does not match');
  });

  it('enforces retention and immutable deletion policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-storage-'));
    roots.push(root);
    const content = new TextEncoder().encode('retained');
    const base = fixture(content);
    const adapter = new LocalStorageAdapter(root);
    await adapter.put(base, new Blob([content]).stream());
    await expect(
      adapter.delete({
        ...base,
        retentionUntil: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toThrow('still retained');
    await expect(adapter.delete({ ...base, immutable: true })).rejects.toThrow(
      'immutable',
    );
    expect(await adapter.exists(base)).toBe(true);
  });
});

describe('signed access', () => {
  it('binds grants to object, operation, subject and expiration', () => {
    const signer = new SignedAccessService('a'.repeat(32));
    const object = fixture(new Uint8Array());
    const issued = signer.issue({
      object,
      subjectId: object.ownerId,
      operation: 'read',
    });
    expect(
      signer.verify(issued.token, { objectId: object.id, operation: 'read' }),
    ).toEqual(issued.grant);
    expect(() =>
      signer.verify(issued.token, {
        objectId: randomUUID(),
        operation: 'read',
      }),
    ).toThrow(SignedAccessError);
    expect(() =>
      signer.verify(`${issued.token}x`, {
        objectId: object.id,
        operation: 'read',
      }),
    ).toThrow(SignedAccessError);
  });
});
