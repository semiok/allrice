import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeObjectKey,
  type ExecutionContext,
  type StorageObject,
} from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';
import type * as Database from '@allrice/database';

const { getToolBrokerFile, recordToolBrokerAudit } = vi.hoisted(() => ({
  getToolBrokerFile: vi.fn(),
  recordToolBrokerAudit: vi.fn(async () => undefined),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getToolBrokerFile,
  recordToolBrokerAudit,
}));
import { executeRiceTool } from '../tool-broker.js';

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function inputFor(fileName = '02-ruled-invoice-table.pdf') {
  const bytes = await readFile(
    new URL(`../../../../tests/fixtures/pdf/${fileName}`, import.meta.url),
  );
  const actor = randomUUID(),
    org = randomUUID(),
    workspace = randomUUID(),
    objectId = randomUUID();
  const context: ExecutionContext = {
    executionId: randomUUID(),
    runId: randomUUID(),
    jobId: randomUUID(),
    worker: { type: 'worker', id: randomUUID() },
    delegatedBy: { type: 'user', id: actor },
    organizationId: org,
    workspaceId: workspace,
    startedAt: new Date().toISOString(),
    policySnapshot: {
      id: randomUUID(),
      organizationId: org,
      subjectId: actor,
      version: 1,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      memberships: [],
      grants: [],
    },
  };
  const object: StorageObject = {
    id: objectId,
    organizationId: org,
    workspaceId: workspace,
    ownerId: actor,
    key: makeObjectKey({
      organizationId: org,
      workspaceId: workspace,
      ownerId: actor,
      category: 'uploads',
      objectId,
    }),
    checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    mediaType: 'application/pdf',
    sizeBytes: bytes.length,
    retentionUntil: null,
    deletedAt: null,
    immutable: false,
  };
  const storageRoot = await mkdtemp(join(tmpdir(), 'allrice-pdf-broker-'));
  roots.push(storageRoot);
  await new LocalStorageAdapter(storageRoot).put(
    object,
    new Blob([new Uint8Array(bytes)]).stream(),
  );
  getToolBrokerFile.mockResolvedValue({
    object,
    fileName,
    visibility: 'private',
    artifactVersionId: null,
    artifactVersion: null,
  });
  return {
    context,
    object,
    storageRoot,
    capabilities: ['storage:read'] as const,
    call: {
      id: randomUUID(),
      name: 'workspace.document.read',
      arguments: { objectId, includeStructure: true } as Record<
        string,
        unknown
      >,
    },
  };
}

describe('PDF through the existing read-only Tool Broker', () => {
  it('returns verified source and raw grid values without write or Python authority', async () => {
    const input = await inputFor();
    const versionId = randomUUID();
    getToolBrokerFile.mockResolvedValueOnce({
      object: input.object,
      fileName: 'invoice.pdf',
      artifactVersionId: versionId,
      artifactVersion: 2,
    });
    const result = await executeRiceTool({
      ...input,
      capabilities: [...input.capabilities],
    });
    const parsed = JSON.parse(result.modelContent);
    expect(parsed.source).toEqual({
      objectId: input.object.id,
      checksum: input.object.checksum,
      sizeBytes: input.object.sizeBytes,
      artifactVersionId: versionId,
      artifactVersion: 2,
    });
    expect(parsed.execution).toEqual({ location: 'cloud', backend: 'worker' });
    expect(parsed.tables[0].pageNumber).toBe(1);
    expect(
      parsed.tables[0].rows.map((row: { cells: string[] }) => row.cells[0]),
    ).toContain('00123');
    expect(result.modelContent).toContain('-200.00');
    expect(result.modelContent).toContain('缺失不是零');
    expect(getToolBrokerFile).toHaveBeenCalledWith(
      input.context,
      input.object.id,
    );
  });

  it('selects the physical page and retains source for an upload with no artifact version', async () => {
    const input = await inputFor('01-chinese-multipage-digital.pdf');
    input.call.arguments.pages = [2];
    const result = await executeRiceTool({
      ...input,
      capabilities: [...input.capabilities],
    });
    const parsed = JSON.parse(result.modelContent);
    expect(parsed.requestedPages).toEqual([2]);
    expect(
      parsed.units.map((unit: { pageNumber: number }) => unit.pageNumber),
    ).toEqual([2]);
    expect(parsed.source).not.toHaveProperty('artifactVersionId');
    expect(result.modelContent).toContain('星河实验室');
    expect(result.modelContent).not.toContain('青松办公室');
    expect(result.modelContent).not.toContain('远山资料室');
  });

  it('refuses changed bytes rather than reporting their old source checksum', async () => {
    const input = await inputFor();
    await writeFile(join(input.storageRoot, input.object.key), 'changed');
    await expect(
      executeRiceTool({ ...input, capabilities: [...input.capabilities] }),
    ).rejects.toMatchObject({ code: 'TOOL_SOURCE_CHANGED' });
  });

  it('keeps capability and source authorization failures before parsing', async () => {
    const input = await inputFor();
    await expect(
      executeRiceTool({ ...input, capabilities: [] }),
    ).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_DENIED' });
    expect(getToolBrokerFile).not.toHaveBeenCalled();
    getToolBrokerFile.mockRejectedValueOnce(new Error('authorization_denied'));
    await expect(
      executeRiceTool({ ...input, capabilities: [...input.capabilities] }),
    ).rejects.toThrow('authorization_denied');
  });

  it('does not mark empty extraction as a successful read', async () => {
    const input = await inputFor('04-scanned-image-only.pdf');
    const result = await executeRiceTool({
      ...input,
      capabilities: [...input.capabilities],
    });
    expect(JSON.parse(result.modelContent).quality).toBe('no_extractable_text');
    expect(result.summary).toContain('未提取到文本');
    expect(result.summary).not.toContain('已解析');
  });
});
