import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeObjectKey, type StorageObject } from '@allrice/contracts';
import type * as Database from '@allrice/database';
import {
  claimReferenceProcessing,
  failReferenceProcessing,
  finishReferenceProcessing,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import { processNextReference } from './reference-processing.js';

vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  claimReferenceProcessing: vi.fn(),
  finishReferenceProcessing: vi.fn(),
  failReferenceProcessing: vi.fn(),
}));

const roots: string[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true })));
});

async function fixture(bytes: Uint8Array, mediaType: string) {
  const root = await mkdtemp(join(tmpdir(), 'allrice-reference-text-'));
  roots.push(root);
  const id = randomUUID(),
    organizationId = randomUUID(),
    workspaceId = randomUUID(),
    ownerId = randomUUID();
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
    checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    mediaType,
    sizeBytes: bytes.byteLength,
    retentionUntil: null,
    deletedAt: null,
    immutable: true,
  };
  await new LocalStorageAdapter(root).put(
    object,
    new Blob([new Uint8Array(bytes)]).stream(),
  );
  const claim = {
    revisionId: randomUUID(),
    token: randomUUID(),
    fileName: '部门金额.csv',
    object,
  };
  vi.mocked(claimReferenceProcessing).mockResolvedValue(claim);
  return { root, claim };
}

it.each(['text/plain', 'text/markdown', 'application/json', 'text/csv'])(
  'processes a claimed fixed %s source through verified storage and text indexing',
  async (mediaType) => {
    const text =
      '部门,账号,金额,备注\n运营,0012,12000,"含逗号,保留"\n财务,0034,18000,=1+1\n';
    const { root, claim } = await fixture(Buffer.from(text), mediaType);
    expect(await processNextReference(root)).toBe(true);
    expect(finishReferenceProcessing).toHaveBeenCalledExactlyOnceWith(claim, [
      { content: text.trim(), start: 0, end: text.trim().length },
    ]);
    expect(failReferenceProcessing).not.toHaveBeenCalled();
  },
);

it.each([
  { mediaType: 'application/pdf', sizeBytes: 20 },
  { mediaType: 'text/csv', sizeBytes: 2_000_001 },
])(
  'rejects unsupported/big sources before attempting storage reads: %j',
  async (metadata) => {
    const { root, claim } = await fixture(
      Buffer.from('部门,金额\n运营,12000'),
      'text/csv',
    );
    Object.assign(claim.object, metadata);
    await rm(root, { recursive: true });
    roots.splice(roots.indexOf(root), 1);
    expect(await processNextReference(root)).toBe(true);
    expect(finishReferenceProcessing).not.toHaveBeenCalled();
    expect(failReferenceProcessing).toHaveBeenCalledExactlyOnceWith(
      claim,
      '文件已保存，可预览和下载；当前格式或大小暂不支持检索。',
      true,
    );
  },
);

it('does not index CSV with a changed declared checksum', async () => {
  const { root, claim } = await fixture(
    Buffer.from('部门,金额\n运营,12000'),
    'text/csv',
  );
  claim.object.checksum = `sha256:${'0'.repeat(64)}`;
  expect(await processNextReference(root)).toBe(true);
  expect(finishReferenceProcessing).not.toHaveBeenCalled();
  expect(failReferenceProcessing).toHaveBeenCalledExactlyOnceWith(
    claim,
    '资料文件校验失败',
  );
});

it('rejects invalid UTF-8 without publishing arbitrary parser or filesystem details', async () => {
  const { root, claim } = await fixture(
    Uint8Array.from([0xff, 0xfe]),
    'text/csv',
  );
  expect(await processNextReference(root)).toBe(true);
  expect(finishReferenceProcessing).not.toHaveBeenCalled();
  expect(failReferenceProcessing).toHaveBeenCalledExactlyOnceWith(
    claim,
    '资料处理失败，请重试；原文件已保留。',
  );
});
