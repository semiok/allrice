import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createEmployeePanelsHttpClient,
  createEmployeePanelsHttpResolver,
  readEmployeePanelsWriteReceipt,
  EmployeePanelsWriteUnknownError,
} from './employee-panel-data-http';
import { ReferenceSelectionUnavailableError } from './reference-selection';

function fixture() {
  const selection = {
    workspaceId: randomUUID(),
    employeeInstanceId: randomUUID(),
    threadId: randomUUID(),
  };
  const sourceId = randomUUID(),
    revisionId = randomUUID(),
    objectId = randomUUID(),
    viewerId = randomUUID();
  const reference = {
    sourceId,
    revisionId,
    revision: 1,
    ownership: {
      scope: 'personal',
      ownerId: viewerId,
      organizationId: randomUUID(),
    },
    fileName: 'fixed.txt',
    purpose: '',
    checksum: 'sha256:' + 'a'.repeat(64),
    sizeBytes: 3,
    mediaType: 'text/plain',
    status: 'active',
    processing: 'saved',
    failure: null,
    canMaintain: true,
    createdAt: new Date().toISOString(),
    origin: null,
  };
  const options = {
    workspaceId: selection.workspaceId,
    platformMaintainer: false,
    maintenanceLevel: 'personal',
    writable: true,
    departmentId: null,
    departments: [],
  };
  const root = `/api/v1/d-entry/panels/${selection.employeeInstanceId}`;
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(String(input), 'https://allrice.example');
    calls.push({ url, init });
    const path = url.pathname.slice(root.length);
    if (path.endsWith('/download'))
      return new Response('abc', { headers: { 'Content-Type': 'text/plain' } });
    let body: unknown;
    if (path === '/materials')
      body = {
        viewerId,
        options,
        references: [],
        matches: [],
        nextCursor: null,
        fullTextCoverage: { ready: 0, unavailable: 0 },
      };
    else if (path === '/materials/options') body = { viewerId, options };
    else if (path.endsWith('/selection'))
      body = {
        viewerId,
        workspaceId: selection.workspaceId,
        selection: {
          sourceId,
          revisionId,
          revision: 1,
          fileName: 'fixed.txt',
          purpose: '',
          digest: reference.checksum,
          checksum: reference.checksum,
          ownership: reference.ownership,
        },
      };
    else if (path.endsWith('/preview'))
      body = {
        kind: 'text',
        text: 'abc',
        mediaType: 'text/plain',
        offset: 1,
        lines: 1,
        eof: true,
      };
    else if (path.endsWith('/reference')) body = { reference };
    else if (path === `/materials/revisions/${revisionId}`) body = reference;
    else if (path.endsWith('/favorite'))
      body = { viewerId, objectId, favorite: true };
    else if (path === '/deliverables')
      body =
        init.method === 'POST'
          ? { objectId }
          : {
              viewerId,
              files: [],
              employees: [],
              nextCursor: null,
              quotableFileIds: [],
            };
    else if (path === '/materials/publications')
      body = { sourceId, revisionId };
    else body = { sourceId };
    return Response.json(body);
  });
  const client = createEmployeePanelsHttpClient(selection, {
    fetch: fetcher,
    expectedViewerId: viewerId,
  });
  const workspaceId = selection.workspaceId,
    signal = new AbortController().signal;
  const upload = {
    workspaceId,
    requestId: randomUUID(),
    fileName: 'fixed.txt',
    mediaType: 'text/plain',
    contentBase64: 'YWJj',
  };
  return {
    client,
    selection,
    sourceId,
    revisionId,
    objectId,
    viewerId,
    fetcher,
    calls,
    workspaceId,
    signal,
    upload,
    reference,
  };
}
describe('sixteen fixed n4 browser methods', () => {
  it('binds all sixteen named methods to exact routes and trusted Cookie transport', async () => {
    const f = fixture(),
      workspace = { workspaceId: f.workspaceId },
      material = { ...workspace, revisionId: f.revisionId },
      file = { ...workspace, objectId: f.objectId };
    await f.client.queryMaterials(
      { ...workspace, query: { category: 'all', query: '中文出处', limit: 2 } },
      f.signal,
    );
    await f.client.publicationOptions(workspace, f.signal);
    await f.client.selectMaterial(material, f.signal);
    await f.client.previewMaterial(
      { ...material, source: true, offset: 7 },
      f.signal,
    );
    expect(
      await (await f.client.downloadMaterial(material, f.signal)).text(),
    ).toBe('abc');
    await f.client.publishFile(
      {
        ...workspace,
        origin: 'file',
        objectId: f.objectId,
        requestId: randomUUID(),
        audience: { scope: 'personal', departmentIds: [] },
        purpose: '',
      },
      f.signal,
    );
    await f.client.publishUpload(
      {
        ...f.upload,
        origin: 'upload',
        audience: { scope: 'personal', departmentIds: [] },
        purpose: '',
      },
      f.signal,
    );
    await f.client.changePublication(
      {
        sourceId: f.sourceId,
        body: {
          ...workspace,
          requestId: randomUUID(),
          expectedRevision: 1,
          action: 'revoke',
        },
      },
      f.signal,
    );
    await f.client.changeSource(
      {
        sourceId: f.sourceId,
        body: {
          ...workspace,
          requestId: randomUUID(),
          expectedRevision: 1,
          action: 'retry',
        },
      },
      f.signal,
    );
    await f.client.listDeliverables(
      { ...workspace, category: 'favorite' },
      f.signal,
    );
    await f.client.captureReference(
      { ...file, requestId: randomUUID() },
      f.signal,
    );
    expect(
      await f.client.readPreparedReference(
        { ...material, sourceId: f.sourceId },
        f.signal,
      ),
    ).toEqual(f.reference);
    await f.client.favorite({ ...file, body: { favorite: true } }, f.signal);
    await f.client.previewDeliverable(
      { ...file, fileName: 'not-authority.pdf' },
      f.signal,
    );
    expect(
      await (await f.client.downloadDeliverable(file, f.signal)).text(),
    ).toBe('abc');
    await f.client.uploadDeliverable(f.upload, f.signal);
    expect(
      f.calls.map(
        ({ url, init }) =>
          `${init.method ?? 'GET'} ${url.pathname.split('/').slice(6).join('/')}`,
      ),
    ).toEqual([
      'GET materials',
      'GET materials/options',
      `GET materials/revisions/${f.revisionId}/selection`,
      `GET materials/revisions/${f.revisionId}/preview`,
      `GET materials/revisions/${f.revisionId}/download`,
      'POST materials/publications',
      'POST materials/publications',
      `POST materials/publications/${f.sourceId}`,
      `POST materials/sources/${f.sourceId}`,
      'GET deliverables',
      `POST deliverables/${f.objectId}/reference`,
      `GET materials/revisions/${f.revisionId}`,
      `PUT deliverables/${f.objectId}/favorite`,
      `GET deliverables/${f.objectId}/preview`,
      `GET deliverables/${f.objectId}/download`,
      'POST deliverables',
    ]);
    for (const { url, init } of f.calls) {
      expect(url.pathname).toMatch(/^\/api\/v1\/d-entry\/panels\//);
      expect(url.searchParams.get('workspaceId')).toBe(f.workspaceId);
      expect(url.searchParams.get('threadId')).toBe(f.selection.threadId);
      expect(init.credentials).toBe('same-origin');
      expect(init.cache).toBe('no-store');
      expect(
        new Headers(init.headers).get('x-allrice-expected-viewer-id'),
      ).toBe(f.viewerId);
      expect(new Headers(init.headers).has('Cookie')).toBe(false);
      expect(url.searchParams.has('viewerId')).toBe(false);
      expect(url.searchParams.has('personId')).toBe(false);
    }
    expect(f.calls[0]!.url.searchParams.get('query')).toBe('中文出处');
    expect(f.calls[3]!.url.searchParams.get('offset')).toBe('7');
    expect(f.calls[3]!.url.searchParams.get('source')).toBe('1');
    expect(f.calls[13]!.url.searchParams.has('name')).toBe(false);
  });
  it('rejects another workspace or invalid IDs before any request', async () => {
    const f = fixture();
    await expect(
      f.client.downloadDeliverable(
        { workspaceId: randomUUID(), objectId: f.objectId },
        f.signal,
      ),
    ).rejects.toThrow('失效');
    await expect(
      f.client.selectMaterial(
        { workspaceId: f.workspaceId, revisionId: '../latest' },
        f.signal,
      ),
    ).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('retains the original write input/key after an unknown response and never automatically replays', async () => {
    const f = fixture();
    f.fetcher.mockRejectedValueOnce(Error('ack lost'));
    const error: unknown = await f.client
      .uploadDeliverable(f.upload, f.signal)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(EmployeePanelsWriteUnknownError);
    expect(error).toMatchObject({
      operation: 'upload',
      requestId: f.upload.requestId,
      originalInput: f.upload,
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses only GET for original-key reconciliation and preserves unknown', async () => {
    const f = fixture(),
      input = {
        workspaceId: f.workspaceId,
        requestId: f.upload.requestId,
        operation: 'upload' as const,
      };
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        ...input,
        workspaceId: undefined,
        status: 'unknown',
        inputDigest: null,
        result: null,
        ready: null,
      }),
    );
    const receipt = await readEmployeePanelsWriteReceipt(
      f.selection,
      input,
      f.signal,
      { fetch: f.fetcher },
    );
    expect(receipt.status).toBe('unknown');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = f.fetcher.mock.calls[0]!;
    expect(String(url)).toContain('/write-receipts/' + f.upload.requestId);
    expect(init?.method).toBeUndefined();
    expect(init?.body).toBeUndefined();
  });
  it('does not reconcile a receipt for another request or operation', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        requestId: randomUUID(),
        operation: 'upload',
        status: 'unknown',
        inputDigest: null,
        result: null,
        ready: null,
      }),
    );
    await expect(
      readEmployeePanelsWriteReceipt(
        f.selection,
        {
          workspaceId: f.workspaceId,
          requestId: f.upload.requestId,
          operation: 'upload',
        },
        f.signal,
        { fetch: f.fetcher },
      ),
    ).rejects.toThrow('不匹配');
  });
  it('keeps the exact selection error and never accepts unrelated failed pins', async () => {
    const f = fixture();
    const error = (ids: string[]) =>
      Response.json(
        {
          error: {
            code: 'REFERENCE_SELECTION_UNAVAILABLE',
            message: 'lost',
            requestId: randomUUID(),
            retryable: false,
            referenceRevisionIds: ids,
          },
        },
        { status: 409 },
      );
    f.fetcher.mockResolvedValueOnce(error([f.revisionId]));
    await expect(
      f.client.selectMaterial(
        { workspaceId: f.workspaceId, revisionId: f.revisionId },
        f.signal,
      ),
    ).rejects.toBeInstanceOf(ReferenceSelectionUnavailableError);
    f.fetcher.mockResolvedValueOnce(error([randomUUID()]));
    await expect(
      f.client.selectMaterial(
        { workspaceId: f.workspaceId, revisionId: f.revisionId },
        f.signal,
      ),
    ).rejects.not.toBeInstanceOf(ReferenceSelectionUnavailableError);
  });
  it('does not save or return partial download bytes if the HTTP body fails', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from('partial'));
            controller.error(Error('body failed'));
          },
        }),
      ),
    );
    await expect(
      f.client.downloadDeliverable(
        { workspaceId: f.workspaceId, objectId: f.objectId },
        f.signal,
      ),
    ).rejects.toThrow('body failed');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('passes the real lifetime cancellation through fetch and rejects a late result', async () => {
    const f = fixture(),
      lifetime = new AbortController();
    const client = createEmployeePanelsHttpClient(f.selection, {
      fetch: f.fetcher,
      lifetimeSignal: lifetime.signal,
    });
    f.fetcher.mockImplementationOnce(async (_input, init) => {
      lifetime.abort(Error('owner retired'));
      expect(init?.signal?.aborted).toBe(true);
      return Response.json({ objectId: f.objectId });
    });
    await expect(
      client.uploadDeliverable(f.upload, f.signal),
    ).rejects.toMatchObject({
      requestId: f.upload.requestId,
      cause: lifetime.signal.reason,
    });
  });
  it('does not bind missing scopes and never falls back to a legacy client', async () => {
    const f = fixture(),
      lifetime = new AbortController();
    const resolver = createEmployeePanelsHttpResolver(
      () => null,
      lifetime.signal,
      { fetch: f.fetcher },
    );
    expect(resolver('native-session', {})).toBeNull();
    expect(f.fetcher).not.toHaveBeenCalled();
    lifetime.abort(Error('binding closed'));
    expect(() => resolver('native-session', {})).toThrow('binding closed');
  });
});
