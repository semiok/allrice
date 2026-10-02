import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { DataAccessError } from '@allrice/database';
import { GET, POST } from './route';
const mocks = vi.hoisted(() => ({
  legacyRead: vi.fn(),
  legacyAuth: vi.fn(),
  legacyStore: vi.fn(),
  pythonRead: vi.fn(),
  pythonAuth: vi.fn(),
  pythonStore: vi.fn(),
  operationCapability: vi.fn(),
  pdfRead: vi.fn(),
  pdfAuth: vi.fn(),
  get: vi.fn(),
}));
vi.mock('@allrice/database', () => ({
  localFileTransferAuthority: mocks.legacyAuth,
  readLocalFileDownload: mocks.legacyRead,
  storeLocalFileUpload: mocks.legacyStore,
  localPythonTransferAuthority: mocks.pythonAuth,
  readLocalPythonInput: mocks.pythonRead,
  storeLocalPythonArtifact: mocks.pythonStore,
  readBridgeOperationTransferCapability: mocks.operationCapability,
  localPdfTransferAuthority: mocks.pdfAuth,
  readLocalPdfInput: mocks.pdfRead,
  DataAccessError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  BridgeDataError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));
vi.mock('../../../../../../../../lib/storage/runtime', () => ({
  getStorageAdapter: () => ({ get: mocks.get }),
}));
afterEach(() => vi.resetAllMocks());
function fixture(kind = 'operation') {
  const id = randomUUID(),
    objectId = randomUUID(),
    lease = randomUUID(),
    bytes = Buffer.from('original binary transfer fixture');
  return {
    id,
    objectId,
    lease,
    bytes,
    route: { params: Promise.resolve({ kind, id }) },
    url: `http://localhost/api/v1/bridge/device/file-transfers/${kind}/${id}`,
    headers: { authorization: 'Bearer test-token', 'x-allrice-lease': lease },
  };
}
it('uses exact operation/object authority to download original bytes', async () => {
  const f = fixture(),
    object = {
      sizeBytes: f.bytes.length,
      checksum: `sha256:${'a'.repeat(64)}`,
    };
  mocks.pythonRead.mockResolvedValue({ object, fileName: 'input.xlsx' });
  mocks.operationCapability.mockResolvedValue('local.python.execute');
  mocks.get.mockResolvedValue(new Uint8Array(f.bytes));
  const response = await GET(
    new Request(`${f.url}?action=download&objectId=${f.objectId}`, {
      headers: f.headers,
    }),
    f.route,
  );
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);
  expect(mocks.pythonRead).toHaveBeenCalledWith(
    'test-token',
    f.id,
    f.lease,
    f.objectId,
  );
  expect(mocks.legacyRead).not.toHaveBeenCalled();
  expect(response.headers.get('Cache-Control')).toContain('no-store');
});
it('keeps the original file-command download protocol unchanged', async () => {
  const f = fixture('command'),
    object = {
      sizeBytes: f.bytes.length,
      checksum: `sha256:${'a'.repeat(64)}`,
    };
  mocks.legacyRead.mockResolvedValue(object);
  mocks.get.mockResolvedValue(new Uint8Array(f.bytes));
  const response = await GET(
    new Request(`${f.url}?action=download`, { headers: f.headers }),
    f.route,
  );
  expect(response.status).toBe(200);
  expect(mocks.legacyRead).toHaveBeenCalledWith(
    'test-token',
    'command',
    f.id,
    f.lease,
  );
  expect(mocks.pythonRead).not.toHaveBeenCalled();
});
it('rejects a Python object on command routes and malformed object identities', async () => {
  const f = fixture('command');
  expect(
    (
      await GET(
        new Request(`${f.url}?action=download&objectId=${f.objectId}`, {
          headers: f.headers,
        }),
        f.route,
      )
    ).status,
  ).toBe(403);
  const op = fixture();
  expect(
    (
      await GET(
        new Request(`${op.url}?action=download&objectId=../private`, {
          headers: op.headers,
        }),
        op.route,
      )
    ).status,
  ).toBe(400);
  expect(mocks.pythonRead).not.toHaveBeenCalled();
  expect(mocks.legacyRead).not.toHaveBeenCalled();
});
it('passes only declared artifact metadata and rejects host paths before upload', async () => {
  const f = fixture(),
    metadata = {
      checksum: `sha256:${'a'.repeat(64)}`,
      sizeBytes: f.bytes.length,
      mediaType: 'image/png',
      validation: 'trusted_png',
    };
  function upload(value: unknown) {
    return new Request(`${f.url}?objectId=${f.objectId}`, {
      method: 'POST',
      headers: {
        ...f.headers,
        'content-type': 'application/octet-stream',
        'x-allrice-file': encodeURIComponent(JSON.stringify(value)),
      },
      body: f.bytes,
    });
  }
  mocks.pythonStore.mockResolvedValue({
    objectId: f.objectId,
    ...metadata,
    collected: true,
  });
  mocks.operationCapability.mockResolvedValue('local.python.execute');
  const response = await POST(upload(metadata), f.route);
  expect(response.status).toBe(200);
  expect(mocks.pythonStore).toHaveBeenCalledWith(
    expect.objectContaining({
      token: 'test-token',
      id: f.id,
      leaseToken: f.lease,
      objectId: f.objectId,
      metadata,
    }),
  );
  mocks.pythonStore.mockClear();
  expect(
    (
      await POST(
        upload({ ...metadata, hostPath: '/Users/private/source' }),
        f.route,
      )
    ).status,
  ).toBe(400);
  expect(mocks.pythonStore).not.toHaveBeenCalled();
  expect(mocks.legacyStore).not.toHaveBeenCalled();
});

it('downloads only the exact PDF source and cannot turn its read lease into an upload', async () => {
  const f = fixture(),
    object = {
      sizeBytes: f.bytes.length,
      checksum: `sha256:${'c'.repeat(64)}`,
    };
  mocks.operationCapability.mockResolvedValue('local.pdf.read');
  mocks.pdfRead.mockResolvedValue({ object, fileName: 'source.pdf' });
  mocks.get.mockResolvedValue(new Uint8Array(f.bytes));
  const downloaded = await GET(
    new Request(`${f.url}?action=download&objectId=${f.objectId}`, {
      headers: f.headers,
    }),
    f.route,
  );
  expect(downloaded.status).toBe(200);
  expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(f.bytes);
  expect(downloaded.headers.get('x-allrice-checksum')).toBe(object.checksum);
  expect(mocks.pdfRead).toHaveBeenCalledWith(
    'test-token',
    f.id,
    f.lease,
    f.objectId,
  );
  expect(mocks.pythonRead).not.toHaveBeenCalled();
  expect(mocks.legacyRead).not.toHaveBeenCalled();
  const authorized = await GET(
    new Request(`${f.url}?action=authorize&objectId=${f.objectId}`, {
      headers: f.headers,
    }),
    f.route,
  );
  expect(authorized.status).toBe(200);
  expect(mocks.pdfAuth).toHaveBeenCalledWith(
    'test-token',
    f.id,
    f.lease,
    f.objectId,
    'authorize',
  );
  for (const query of [`?objectId=${f.objectId}`, '']) {
    const uploaded = await POST(
      new Request(`${f.url}${query}`, {
        method: 'POST',
        headers: {
          ...f.headers,
          'content-type': 'application/octet-stream',
          'x-allrice-file': encodeURIComponent(
            JSON.stringify({
              checksum: object.checksum,
              sizeBytes: f.bytes.length,
              mediaType: 'image/png',
              validation: 'trusted_png',
            }),
          ),
        },
        body: f.bytes,
      }),
      f.route,
    );
    expect(uploaded.status).toBe(403);
  }
  expect(mocks.pythonStore).not.toHaveBeenCalled();
  expect(mocks.legacyStore).not.toHaveBeenCalled();
});

it('uses the authenticated immutable operation instead of a capability query or authorization error fallback', async () => {
  const f = fixture();
  mocks.operationCapability.mockResolvedValue('local.fs.read');
  const response = await GET(
    new Request(
      `${f.url}?action=download&objectId=${f.objectId}&capability=local.pdf.read`,
      { headers: f.headers },
    ),
    f.route,
  );
  expect(response.status).toBe(403);
  expect(mocks.pdfRead).not.toHaveBeenCalled();
  expect(mocks.pythonRead).not.toHaveBeenCalled();
  mocks.operationCapability.mockRejectedValue(
    new DataAccessError('authorization_denied'),
  );
  expect(
    (
      await GET(
        new Request(`${f.url}?action=download&objectId=${f.objectId}`, {
          headers: f.headers,
        }),
        f.route,
      )
    ).status,
  ).toBe(403);
  expect(mocks.pdfRead).not.toHaveBeenCalled();
  expect(mocks.legacyRead).not.toHaveBeenCalled();
});
