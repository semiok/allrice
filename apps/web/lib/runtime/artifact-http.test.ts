import type * as OfficeRuntime from '@allrice/office-runtime';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DatabaseModule from '@allrice/database';
import { ArtifactReviewError } from '@allrice/database';
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
}));
vi.mock('@allrice/office-runtime', async (original) => ({
  ...(await original<typeof OfficeRuntime>()),
  renderOffice: ports.render,
}));
vi.mock('../identity/session', () => ({ getRequestContext: ports.context }));
vi.mock('../storage/runtime', () => ({ getStorageAdapter: () => ({}) }));
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
describe('authenticated workbench HTTP boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ports.enabled.mockReturnValue(true);
    ports.context.mockResolvedValue(context);
    ports.list.mockResolvedValue({ artifacts: [], nextCursor: null });
    ports.get.mockResolvedValue({
      id,
      kind: 'document',
      object: { mediaType: 'text/plain', sizeBytes: 10 },
    });
    ports.feedback.mockResolvedValue([]);
    ports.read.mockResolvedValue(Buffer.from('hello'));
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
  it('returns HTML and SVG only as inert JSON text with restrictive headers', async () => {
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
        kind: 'text',
        text: html,
        mediaType,
      });
    }
  });
  it('does not inline large or unsupported binaries', async () => {
    for (const object of [
      { mediaType: 'application/pdf', sizeBytes: 8_000_001 },
      { mediaType: 'application/zip', sizeBytes: 10 },
      { mediaType: 'text/plain', sizeBytes: 512_001 },
    ]) {
      ports.get.mockResolvedValue({ id, kind: 'document', object });
      expect(
        (await (await artifactHttp(request(), 'content', sessionId, id)).json())
          .kind,
      ).toBe('download_only');
    }
    expect(ports.read).not.toHaveBeenCalled();
  });
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
    expect(ports.read).toHaveBeenCalledWith({}, object, 8_000_000);
    expect(ports.get).toHaveBeenCalledTimes(2);
  });
  it('rechecks identity after storage IO without returning already-read bytes on revocation', async () => {
    ports.get
      .mockResolvedValueOnce({
        id,
        kind: 'document',
        object: { mediaType: 'text/plain', sizeBytes: 10 },
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
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeBytes: 600_000,
      },
    };
    const rendered = {
      checksum: `sha256:${'a'.repeat(64)}`,
      format: 'xlsx',
      engine: 'LibreOffice',
      pageCount: 1,
      pages: [{ number: 1, base64: 'PRIVATE_PAGE' }],
      formulas: [],
    };
    ports.get.mockResolvedValue(office);
    ports.render.mockResolvedValue(rendered);
    const allowed = await artifactHttp(request(), 'content', sessionId, id);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      kind: 'office',
      pages: rendered.pages,
    });
    expect(ports.read).toHaveBeenCalledWith({}, office.object, 8_000_000);
    expect(ports.render).toHaveBeenCalledWith(Buffer.from('hello'), 'xlsx');
    ports.get
      .mockResolvedValueOnce(office)
      .mockRejectedValueOnce(new ArtifactReviewError('identity_denied'));
    const denied = await artifactHttp(request(), 'content', sessionId, id);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain('PRIVATE_PAGE');
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
      {},
    );
    expect(ports.address).not.toHaveBeenCalled();
  });
  it('does not reflect database diagnostics', async () => {
    ports.get.mockRejectedValueOnce(new Error('SECRET_BACKEND_CONFIG'));
    const response = await artifactHttp(request(), 'detail', sessionId, id);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"code":"ARTIFACT_UNAVAILABLE"}');
  });
});
