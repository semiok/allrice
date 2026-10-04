import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkbenchArtifactSchema,
  ArtifactBrowserVerificationSchema,
  type RuntimeExecutionScope,
} from '@allrice/contracts';
import {
  artifactKindLabel,
  artifactExecutionLabels,
  boundedRichDiff,
  mergeArtifactPage,
  parseArtifactDetail,
  parseArtifactList,
  parseArtifactPreview,
  reviewAnchorLabel,
  workbenchJson,
} from './workbench-model';
const id = randomUUID(),
  oid = randomUUID(),
  ownerId = randomUUID(),
  organizationId = randomUUID(),
  workspaceId = randomUUID(),
  checksum = `sha256:${'a'.repeat(64)}`,
  now = new Date().toISOString();
const artifact = WorkbenchArtifactSchema.parse({
  contractVersion: 1,
  id,
  kind: 'document',
  version: {
    id,
    objectId: oid,
    organizationId,
    workspaceId,
    ownerId,
    seriesId: randomUUID(),
    version: 1,
    parentVersionId: null,
    parentObjectId: null,
    sessionId: randomUUID(),
    platformTestRunId: null,
    fileName: '<svg onload="alert(1)">',
    format: 'text',
    changeSummary: null,
    createdAt: now,
  },
  object: {
    id: oid,
    organizationId,
    workspaceId,
    ownerId,
    key: `organizations/${organizationId}/workspaces/${workspaceId}/owners/${ownerId}/exports/${oid}`,
    mediaType: 'text/plain',
    checksum,
    sizeBytes: 10,
    retentionUntil: null,
    deletedAt: null,
    immutable: true,
  },
  provenance: {
    kind: 'model_proposal',
    runId: randomUUID(),
    operationId: null,
    stepId: null,
  },
  execution: null,
  latestVersionId: id,
  stale: false,
});
afterEach(() => vi.unstubAllGlobals());
describe('workbench UI boundary', () => {
  it('distinguishes historical cloud, MCP and Bridge execution provenance', () => {
    const scope: RuntimeExecutionScope = {
      targetId: randomUUID(),
      targetKind: 'cloud_sandbox',
      deviceId: null,
      grantId: randomUUID(),
      grantVersion: 1,
      scopeDigest: checksum,
      workCopy: { id: randomUUID(), kind: 'cloud_copy' },
    };
    expect(artifactExecutionLabels(scope)).toEqual({
      target: '云端沙箱',
      workCopy: '云端隔离副本',
      availability: '执行时的目标记录，不代表当前运行状态',
    });
    expect(
      artifactExecutionLabels({
        ...scope,
        targetKind: 'cloud_mcp',
        workCopy: { ...scope.workCopy, kind: 'remote_service' },
      }),
    ).toEqual({
      target: '远程 MCP 服务',
      workCopy: '远程服务（无本地工作副本）',
      availability: '执行时的目标记录，不代表当前运行状态',
    });
    expect(
      artifactExecutionLabels({
        ...scope,
        targetKind: 'rice_bridge',
        deviceId: randomUUID(),
        workCopy: { ...scope.workCopy, kind: 'in_place' },
      }),
    ).toEqual({
      target: '本地 Bridge',
      workCopy: '授权原目录',
      availability: '此处不证明设备当前在线',
    });
  });
  it('validates bounded pages, identities and cursors', () => {
    expect(
      parseArtifactList({ artifacts: [artifact], nextCursor: null }).artifacts,
    ).toEqual([artifact]);
    for (const input of [
      null,
      {},
      { artifacts: Array(51).fill(artifact), nextCursor: null },
      { artifacts: [{ ...artifact, id: randomUUID() }], nextCursor: null },
      { artifacts: [], nextCursor: { id: 'bad', createdAt: now } },
    ])
      expect(() => parseArtifactList(input)).toThrow();
    expect(parseArtifactDetail({ artifact, feedback: [] }).artifact.id).toBe(
      id,
    );
    expect(() =>
      parseArtifactDetail({ artifact, feedback: Array(101).fill({}) }),
    ).toThrow();
  });
  it('accepts typed preview bytes and rejects remote URLs or invalid encodings', () => {
    const text =
      '<script>alert(1)</script><img src="https://untrusted.invalid/">';
    expect(
      parseArtifactPreview({ kind: 'text', text, mediaType: 'text/html' }),
    ).toEqual({ kind: 'text', text, mediaType: 'text/html' });
    for (const input of [
      { kind: 'html', text },
      {
        kind: 'image',
        mediaType: 'image/png',
        base64: 'https://invalid/path?',
      },
      { kind: 'image', mediaType: 'image/png', base64: 'AAA' },
      {
        kind: 'text',
        text: 'x'.repeat(2 * 1024 * 1024 + 1),
        mediaType: 'text/plain',
      },
    ])
      expect(() => parseArtifactPreview(input)).toThrow();
    expect(
      parseArtifactPreview({ kind: 'download_only', reason: 'download' }).kind,
    ).toBe('download_only');
  });
  it('parses saved-page results, preserves older records, and refuses a mismatched or incomplete passed report', () => {
    const observationId = randomUUID();
    const verification = ArtifactBrowserVerificationSchema.parse({
      reportArtifactId: artifact.id,
      screenshotArtifactId: randomUUID(),
      outcome: {
        version: 1,
        verificationId: randomUUID(),
        location: 'cloud',
        executionReason: 'local_offline',
        targetId: randomUUID(),
        deviceId: null,
        attemptId: randomUUID(),
        containerId: 'a'.repeat(64),
        imageDigest: checksum,
        browserVersion: 'synthetic-contract',
        physicalStopConfirmed: true,
        screenshotChecksum: checksum,
        screenshotObjectId: null,
        screenshotObservationId: observationId,
        plan: {
          version: 1,
          timeoutMs: 30000,
          steps: [{ type: 'text_contains', expected: '42' }],
        },
        report: {
          version: 1,
          target: {
            version: 1,
            versionId: randomUUID(),
            objectId: randomUUID(),
            checksum,
            sizeBytes: 42,
            mediaType: 'text/html',
            fileName: 'index.html',
            sourceOperationId: null,
            sourceSessionId: artifact.version.sessionId,
          },
          planDigest: checksum,
          startedAt: now,
          completedAt: now,
          verdict: 'passed',
          errorCode: null,
          steps: [
            {
              index: 0,
              type: 'text_contains',
              status: 'passed',
              observationId,
              pageDigest: checksum,
              expected: '42',
              actual: '42',
              errorCode: null,
            },
          ],
        },
      },
    });
    expect(
      parseArtifactDetail({
        artifact,
        feedback: [],
        browserVerification: verification,
      }).browserVerification?.outcome.report.verdict,
    ).toBe('passed');
    expect(
      parseArtifactDetail({ artifact, feedback: [] }).browserVerification,
    ).toBeNull();
    expect(() =>
      parseArtifactDetail({
        artifact,
        feedback: [],
        browserVerification: {
          ...verification,
          reportArtifactId: randomUUID(),
        },
      }),
    ).toThrow();
    expect(() =>
      parseArtifactDetail({
        artifact,
        feedback: [],
        browserVerification: {
          ...verification,
          outcome: {
            ...verification.outcome,
            report: { ...verification.outcome.report, steps: [] },
          },
        },
      }),
    ).toThrow();
  });
  it.each(['image/png', 'image/jpeg', 'image/webp'])(
    'admits %s images above the text cap up to 32 MiB, including base64 padding',
    (mediaType) => {
      for (const size of [3_358_298, 32 * 1024 * 1024]) {
        const input = {
          kind: 'image',
          mediaType,
          base64: Buffer.alloc(size).toString('base64'),
        };
        expect(parseArtifactPreview(input)).toEqual(input);
      }
      // Check decoded bytes, including limits that share a padded base64 length.
      for (const size of [32 * 1024 * 1024 + 1, 32 * 1024 * 1024 + 2])
        expect(() =>
          parseArtifactPreview({
            kind: 'image',
            mediaType,
            base64: Buffer.alloc(size).toString('base64'),
          }),
        ).toThrow();
    },
  );
  it('bounds rich diff bytes, line count and individual line length', () => {
    expect(boundedRichDiff(null, 'hello\r\n')).toBe(true);
    expect(boundedRichDiff('x'.repeat(4001), null)).toBe(false);
    expect(boundedRichDiff('x\n'.repeat(2500), null)).toBe(false);
    expect(boundedRichDiff(('中'.repeat(1000) + '\n').repeat(50), null)).toBe(
      false,
    );
  });
  it('updates a repeated version without discarding prior pages', () => {
    const stale = { ...artifact, latestVersionId: randomUUID(), stale: true };
    expect(mergeArtifactPage([artifact], [stale])).toEqual([stale]);
    expect(artifactKindLabel({ ...artifact, kind: 'changeset' })).toBe(
      '修改提案',
    );
    expect(
      reviewAnchorLabel({
        kind: 'lines',
        path: 'a.ts',
        side: 'before',
        startLine: 1,
        endLine: 3,
        checksum,
      }),
    ).toBe('a.ts · 修改前 L1–3');
  });
  it('forces authenticated no-store reads and never reflects backend diagnostics', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('{"secret":"NEVER_SHOW"}', { status: 409 }),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(workbenchJson('/synthetic', {})).rejects.toThrow('草稿已变化');
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      cache: 'no-store',
      credentials: 'same-origin',
    });
    fetch.mockResolvedValue(new Response('SECRET', { status: 500 }));
    await expect(workbenchJson('/synthetic', {})).rejects.not.toThrow('SECRET');
  });
});
