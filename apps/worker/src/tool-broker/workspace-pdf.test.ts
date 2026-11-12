import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeObjectKey,
  OfficeCreateSchema,
  type ExecutionContext,
  type StorageObject,
} from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';
import JSZip from 'jszip';
import { createOffice } from '../office/create.js';
import { processNextReference } from '../reference-processing.js';
import type * as Database from '@allrice/database';

const {
  getToolBrokerFile,
  recordToolBrokerAudit,
  claimReferenceProcessing,
  finishReferenceProcessing,
  failReferenceProcessing,
} = vi.hoisted(() => ({
  getToolBrokerFile: vi.fn(),
  recordToolBrokerAudit: vi.fn(async () => undefined),
  claimReferenceProcessing: vi.fn(),
  finishReferenceProcessing: vi.fn(),
  failReferenceProcessing: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getToolBrokerFile,
  recordToolBrokerAudit,
  claimReferenceProcessing,
  finishReferenceProcessing,
  failReferenceProcessing,
}));
import { executeRiceTool } from '../tool-broker.js';

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function inputFor(
  fileName = '02-ruled-invoice-table.pdf',
  content?: { bytes: Buffer; mediaType: string },
) {
  const bytes =
    content?.bytes ??
    (await readFile(
      new URL(`../../../../tests/fixtures/pdf/${fileName}`, import.meta.url),
    ));
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
    mediaType: content?.mediaType ?? 'application/pdf',
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

describe('bounded Office read preserves available text without claiming full-text readiness', () => {
  it.each(['missing', 'sparse'] as const)(
    'reads the same %s chart-cache PPTX through the real broker while the real Worker rejects full text',
    async (cache) => {
      const out = await createOffice(
        OfficeCreateSchema.parse({
          kind: 'pptx',
          title: '图表月报',
          slides: [
            { title: '可读首页', body: ['已有正文仍应可读'] },
            {
              title: '可读图表页',
              chart: {
                type: 'bar',
                labels: ['九月', '十月'],
                series: [{ name: '收入', values: [12, 20] }],
              },
            },
          ],
        }),
      );
      const zip = await JSZip.loadAsync(out.bytes),
        path = 'ppt/charts/chart1.xml';
      const xml = await zip.file(path)!.async('string');
      expect(xml).toContain('<c:numCache>');
      zip.file(
        path,
        xml.replace(/<c:numCache>[\s\S]*?<\/c:numCache>/g, (value) =>
          cache === 'missing'
            ? ''
            : value.replace(/<c:pt idx="1">[\s\S]*?<\/c:pt>/, ''),
        ),
      );
      const bytes = await zip.generateAsync({ type: 'nodebuffer' });
      const input = await inputFor('chart.pptx', {
        bytes,
        mediaType: out.mediaType,
      });
      input.call.arguments.includeStructure = false;
      input.call.arguments.maxCharacters = 1000;
      const result = await executeRiceTool({
        ...input,
        capabilities: [...input.capabilities],
      });
      const parsed = JSON.parse(result.modelContent);
      expect(parsed.text).toContain('已有正文仍应可读');
      expect(parsed.text).toContain('可读图表页');
      expect(
        parsed.units.map((unit: { pageNumber: number }) => unit.pageNumber),
      ).toEqual([1, 2]);
      expect(parsed.truncated).toBe(true);
      expect(parsed.warnings).toContain(
        '部分图表正文未完整提取；以下仅为已提取文字，不代表全文。',
      );
      const claim = {
        revisionId: randomUUID(),
        token: randomUUID(),
        fileName: 'chart.pptx',
        object: { ...input.object, immutable: true },
      };
      claimReferenceProcessing.mockResolvedValueOnce(claim);
      expect(await processNextReference(input.storageRoot)).toBe(true);
      expect(finishReferenceProcessing).not.toHaveBeenCalled();
      expect(failReferenceProcessing).toHaveBeenCalledExactlyOnceWith(
        claim,
        '图表正文暂不能完整提取，尚不可全文检索；原文件已保留。',
        true,
      );
    },
  );
});

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
