import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DatabaseModule from '@allrice/database';
import {
  ArtifactReviewError,
  DataAccessError,
  IdentityError,
} from '@allrice/database';
import { artifactHttp } from './artifact-http';

const ports = vi.hoisted(() => ({
  enabled: vi.fn(),
  context: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  feedback: vi.fn(),
  save: vi.fn(),
  address: vi.fn(),
  read: vi.fn(),
  render: vi.fn(),
  adapter: vi.fn(),
  storage: { get: vi.fn() },
}));
vi.mock('@allrice/office-runtime/preview', () => ({
  previewOfficePdf: ports.render,
}));
vi.mock('../identity/session', () => ({ getRequestContext: ports.context }));
vi.mock('../storage/runtime', () => ({
  getStorageAdapter: ports.adapter,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof DatabaseModule>()),
  workbenchEnabled: ports.enabled,
  listWorkbenchArtifacts: ports.list,
  getWorkbenchArtifact: ports.get,
  listArtifactFeedback: ports.feedback,
  saveArtifactFeedback: ports.save,
  addressArtifactFeedback: ports.address,
  readArtifactBytes: ports.read,
}));
const context = {
    actor: { type: 'user', id: randomUUID() },
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
  },
  sessionId = randomUUID(),
  id = randomUUID();
const request = (body?: unknown, origin = 'http://localhost') =>
  new Request('http://localhost/artifacts', {
    method: body ? 'POST' : 'GET',
    headers: { origin, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const expectPrivateHeaders = (response: Response) => {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-security-policy')).toContain(
    "default-src 'none'",
  );
};
describe('authenticated workbench HTTP boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ports.enabled.mockReturnValue(true);
    ports.context.mockResolvedValue(context);
    ports.list.mockResolvedValue({ artifacts: [], nextCursor: null });
    ports.get.mockResolvedValue({
      id,
      kind: 'document',
      object: {
        mediaType: 'text/plain',
        sizeBytes: 5,
        checksum:
          'sha256:' + createHash('sha256').update('hello').digest('hex'),
      },
    });
    ports.feedback.mockResolvedValue([]);
    ports.read.mockResolvedValue(Buffer.from('hello'));
    ports.adapter.mockReturnValue(ports.storage);
    ports.storage.get.mockImplementation(async () =>
      new Blob(['hello']).stream(),
    );
    ports.save.mockResolvedValue({ state: 'submitted' });
  });
  it('keeps flags, authentication and origin separate', async () => {
    ports.enabled.mockReturnValue(false);
    expect((await artifactHttp(request(), 'list', sessionId)).status).toBe(404);
    expect(ports.context).not.toHaveBeenCalled();
    ports.enabled.mockReturnValue(true);
    ports.context.mockResolvedValue(null);
    expect((await artifactHttp(request(), 'list', sessionId)).status).toBe(401);
    expect(
      (
        await artifactHttp(
          request({ artifactId: id }, 'https://foreign.invalid'),
          'submit',
          sessionId,
          id,
        )
      ).status,
    ).toBe(403);
    expect(ports.save).not.toHaveBeenCalled();
  });
  it.each([
    ['authentication_failed', 401, 'AUTHENTICATION_REQUIRED'],
    ['tenant_context_invalid', 403, 'AUTHORIZATION_DENIED'],
    ['authorization_denied', 403, 'AUTHORIZATION_DENIED'],
  ] as const)(
    'returns the identity denial for %s before accessing any artifact or storage',
    async (code, status, problemCode) => {
      ports.context.mockRejectedValue(new IdentityError(code));
      for (const action of ['list', 'content'] as const) {
        const response = await artifactHttp(request(), action, sessionId, id);
        expect(response.status).toBe(status);
        expectPrivateHeaders(response);
        expect(await response.json()).toMatchObject({
          error: { code: problemCode, retryable: false },
        });
      }
      for (const port of [
        ports.list,
        ports.get,
        ports.feedback,
        ports.save,
        ports.address,
        ports.read,
        ports.render,
        ports.adapter,
        ports.storage.get,
      ])
        expect(port).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['authorization_denied', 403, 'AUTHORIZATION_DENIED'],
    ['not_found', 404, 'RESOURCE_NOT_FOUND'],
  ] as const)(
    'preserves the storage %s response without returning content',
    async (code, status, problemCode) => {
      ports.storage.get.mockRejectedValueOnce(new DataAccessError(code));
      const response = await artifactHttp(request(), 'content', sessionId, id);
      expect(response.status).toBe(status);
      expectPrivateHeaders(response);
      const result = await response.json();
      expect(result).toMatchObject({
        error: { code: problemCode, retryable: false },
      });
      expect(JSON.stringify(result)).not.toContain('hello');
      expect(ports.get).toHaveBeenCalledTimes(1);
      expect(ports.storage.get).toHaveBeenCalledTimes(1);
      expect(ports.feedback).not.toHaveBeenCalled();
      expect(ports.render).not.toHaveBeenCalled();
    },
  );
  it('discards content when the post-read authorization check is denied', async () => {
    const object = {
      mediaType: 'text/plain',
      sizeBytes: 5,
      checksum: 'sha256:' + createHash('sha256').update('hello').digest('hex'),
    };
    ports.get
      .mockResolvedValueOnce({ id, kind: 'document', object })
      .mockRejectedValueOnce(new DataAccessError('authorization_denied'));
    const response = await artifactHttp(request(), 'content', sessionId, id);
    expect(response.status).toBe(403);
    expectPrivateHeaders(response);
    const result = await response.json();
    expect(result).toMatchObject({
      error: { code: 'AUTHORIZATION_DENIED', retryable: false },
    });
    expect(JSON.stringify(result)).not.toContain('hello');
    expect(ports.storage.get).toHaveBeenCalledTimes(1);
    expect(ports.get).toHaveBeenCalledTimes(2);
  });
  it('rejects route/body identity mismatch, invalid cursors and oversized input', async () => {
    expect(
      (
        await artifactHttp(
          request({ artifactId: randomUUID() }),
          'submit',
          sessionId,
          id,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await artifactHttp(
          new Request('http://localhost/artifacts?before=%7B%7D'),
          'list',
          sessionId,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await artifactHttp(
          request({ artifactId: id, text: 'x'.repeat(300_001) }),
          'submit',
          sessionId,
          id,
        )
      ).status,
    ).toBe(413);
    expect(ports.save).not.toHaveBeenCalled();
  });
  it('returns HTML and SVG bytes inside inert JSON with restrictive headers', async () => {
    const html =
      '<script>fetch("https://attacker.invalid")</script><svg onload="alert(1)" />';
    ports.read.mockResolvedValue(Buffer.from(html));
    for (const mediaType of ['text/html', 'image/svg+xml']) {
      ports.get.mockResolvedValue({
        id,
        kind: 'document',
        object: { mediaType, sizeBytes: html.length },
      });
      const response = await artifactHttp(request(), 'content', sessionId, id);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toContain(
        "default-src 'none'",
      );
      expect(await response.json()).toEqual({
        kind: mediaType === 'text/html' ? 'html' : 'image',
        base64: Buffer.from(html).toString('base64'),
        ...(mediaType === 'image/svg+xml' ? { mediaType } : {}),
      });
    }
  });
  it('does not inline large or unsupported binaries', async () => {
    for (const object of [
      { mediaType: 'application/pdf', sizeBytes: 32 * 1024 * 1024 + 1 },
      { mediaType: 'application/zip', sizeBytes: 10, fileName: 'archive.zip' },
      { mediaType: 'image/png', sizeBytes: 32 * 1024 * 1024 + 1 },
    ]) {
      ports.get.mockResolvedValue({
        id,
        kind: 'document',
        object,
        version: { fileName: 'fileName' in object ? object.fileName : '' },
      });
      expect(
        (await (await artifactHttp(request(), 'content', sessionId, id)).json())
          .kind,
      ).toBe('download_only');
    }
    expect(ports.read).not.toHaveBeenCalled();
  });
  it.each([512_001, 8_000_000, 9_000_000])(
    'previews a %i-byte image through the image read limit and rechecks access',
    async (sizeBytes) => {
      const object = { mediaType: 'image/png', sizeBytes };
      ports.get.mockResolvedValue({ id, kind: 'file', object });
      // The storage port verifies declared size and checksum; this boundary
      // test checks native admission and the post-read authorization boundary.
      const bytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      );
      ports.read.mockResolvedValue(bytes);
      const response = await artifactHttp(request(), 'content', sessionId, id);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        kind: 'image',
        mediaType: 'image/png',
        base64: bytes.toString('base64'),
      });
      expect(ports.read).toHaveBeenCalledWith(
        ports.storage,
        object,
        32 * 1024 * 1024,
      );
      expect(ports.get).toHaveBeenCalledTimes(2);
      ports.get
        .mockResolvedValueOnce({ id, kind: 'file', object })
        .mockRejectedValueOnce(new ArtifactReviewError('identity_denied'));
      const denied = await artifactHttp(request(), 'content', sessionId, id);
      expect(denied.status).toBe(403);
      expect(await denied.text()).not.toContain(bytes.toString('base64'));
    },
  );
  it('returns bounded PDF bytes for the native renderer after rechecking access', async () => {
    const object = { mediaType: 'application/pdf', sizeBytes: 10 };
    ports.get.mockResolvedValue({ id, kind: 'document', object });
    const bytes = Buffer.from('%PDF-1.4\n');
    ports.read.mockResolvedValue(bytes);
    const response = await artifactHttp(request(), 'content', sessionId, id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: 'pdf',
      base64: bytes.toString('base64'),
    });
    expect(ports.read).toHaveBeenCalledWith(
      ports.storage,
      object,
      32 * 1024 * 1024,
    );
    expect(ports.get).toHaveBeenCalledTimes(2);
  });
  it('rechecks identity after storage IO without returning already-read bytes on revocation', async () => {
    ports.get
      .mockResolvedValueOnce({
        id,
        kind: 'document',
        object: {
          mediaType: 'text/plain',
          sizeBytes: 5,
          checksum:
            'sha256:' + createHash('sha256').update('hello').digest('hex'),
        },
      })
      .mockRejectedValueOnce(new ArtifactReviewError('identity_denied'));
    const response = await artifactHttp(request(), 'content', sessionId, id);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('hello');
  });
  it('previews the authorized Office version and rechecks access after rendering, including cache hits', async () => {
    const office = {
      id,
      kind: 'document',
      object: {
        mediaType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: 600_000,
      },
    };
    const rendered = {
      pdf: Buffer.from('%PDF_PRIVATE_PAGE'),
      missingFonts: [],
    };
    ports.get.mockResolvedValue(office);
    ports.render.mockResolvedValue(rendered);
    const allowed = await artifactHttp(request(), 'content', sessionId, id);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      kind: 'pdf',
      base64: rendered.pdf.toString('base64'),
      converted: true,
    });
    expect(ports.render).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'docx', sizeBytes: 600_000 }),
    );
    ports.get
      .mockResolvedValueOnce(office)
      .mockRejectedValueOnce(new ArtifactReviewError('identity_denied'));
    const denied = await artifactHttp(request(), 'content', sessionId, id);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain(rendered.pdf.toString('base64'));
    ports.render.mockRejectedValue(Error('PRIVATE_DIAGNOSTIC'));
    const unavailable = await artifactHttp(request(), 'content', sessionId, id);
    expect(await unavailable.json()).toMatchObject({
      kind: 'download_only',
      reason: expect.stringContaining('暂不可用'),
    });
  });
  it('submits feedback through the owner-scoped service and never executes an operation', async () => {
    const input = { artifactId: id, feedbackId: randomUUID() };
    const response = await artifactHttp(
      request(input),
      'submit',
      sessionId,
      id,
    );
    expect(await response.json()).toEqual({ feedback: { state: 'submitted' } });
    expect(ports.save).toHaveBeenCalledWith(
      context,
      sessionId,
      input,
      true,
      ports.storage,
    );
    expect(ports.address).not.toHaveBeenCalled();
  });
  it('does not reflect database diagnostics', async () => {
    ports.get.mockRejectedValueOnce(
      Object.assign(new Error('SECRET_BACKEND_CONFIG'), { code: '42P01' }),
    );
    const response = await artifactHttp(request(), 'detail', sessionId, id);
    expect(response.status).toBe(500);
    expectPrivateHeaders(response);
    expect(await response.text()).toBe('{"code":"ARTIFACT_UNAVAILABLE"}');
  });
  it('records preview failure codes without recording backend secrets', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      ports.get.mockRejectedValueOnce(
        Object.assign(new Error('SECRET_BACKEND_CONFIG'), {
          code: 'CONNECT_TIMEOUT',
          cause: Object.assign(new Error('private storage URL'), {
            code: 'ETIMEDOUT',
          }),
        }),
      );
      const response = await artifactHttp(request(), 'content', sessionId, id);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('{"code":"ARTIFACT_UNAVAILABLE"}');
      expect(log).toHaveBeenCalledWith(
        'Document preview failed',
        expect.objectContaining({
          stage: 'artifact-request',
          referenceId: id,
          causes: [
            { name: 'Error', code: 'CONNECT_TIMEOUT' },
            { name: 'Error', code: 'ETIMEDOUT' },
          ],
        }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /SECRET_BACKEND_CONFIG|private storage URL/,
      );
    } finally {
      log.mockRestore();
    }
  });
});
