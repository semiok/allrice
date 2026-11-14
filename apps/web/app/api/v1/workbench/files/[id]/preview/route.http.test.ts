import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import type * as PreviewDiagnosticsModule from '../../../../../../../server/preview-diagnostics.mjs';

const ports = vi.hoisted(() => ({
  context: vi.fn(),
  file: vi.fn(),
  read: vi.fn(),
  office: vi.fn(),
}));
vi.mock('../../../../../../../lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  readWorkbenchFile: ports.file,
  readArtifactBytes: ports.read,
}));
vi.mock('../../../../../../../lib/storage/runtime', () => ({
  getStorageAdapter: () => ({}),
}));
vi.mock('@allrice/office-runtime/preview', () => ({
  previewOfficePdf: ports.office,
}));
import {
  ArtifactReviewError,
  DataAccessError,
  ReferenceLibraryError,
  WorkbenchFileError,
} from '@allrice/database';
import { storageErrorResponse } from '../../../../../../../lib/storage/responses';
import { workbenchFileError } from '../../../../../../../lib/workbench-files';
import { previewRequestDiagnostics } from '../../../../../../../lib/runtime/preview-diagnostics';
import {
  activePreviewDiagnostics,
  observePreviewHttp,
} from '../../../../../../../server/preview-diagnostics.mjs';
import { GET } from './route';

const id = '00000000-0000-4000-8000-000000000901';
const workspace = '00000000-0000-4000-8000-000000000004';
const secret = 'secret-body https://private.invalid/path?token=credential';
// Retired diagnostic headers are deliberately untrusted client input.
const previewRequestHeader = 'x-allrice-preview-request-id';
const previewStartedHeader = 'x-allrice-preview-started';
const source = Buffer.from(secret);
const storedFile = {
  object: {
    id,
    sizeBytes: source.length,
    checksum: 'sha256:' + createHash('sha256').update(source).digest('hex'),
    mediaType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  row: { file_name: 'private-name.docx' },
};
const servers: Server[] = [];
const tasks: Promise<void>[] = [];
const directories: string[] = [];
let infoCalls: unknown[][], errorCalls: unknown[][];
const records = () =>
  [...infoCalls, ...errorCalls]
    .filter(
      ([label]) =>
        label === 'Document preview' || label === 'Document preview failed',
    )
    .map(([, entry]) => entry as Record<string, unknown>);

beforeEach(() => {
  vi.resetAllMocks();
  infoCalls = [];
  errorCalls = [];
  vi.spyOn(console, 'info').mockImplementation((...args) => {
    infoCalls.push(args);
  });
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    errorCalls.push(args);
  });
  ports.context.mockResolvedValue({
    actor: { type: 'user', id },
    organizationId: workspace,
    workspaceId: workspace,
  });
  ports.file.mockResolvedValue(storedFile);
  ports.read.mockResolvedValue(source);
  ports.office.mockImplementation(async (input) => {
    await input.read(input.signal, source.length);
    return {
      pdf: Buffer.from('%PDF-fixture'),
      missingFonts: ['Noto Sans CJK SC'],
    };
  });
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.allSettled(tasks.splice(0));
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function fixture(path = `/api/v1/workbench/files/${id}/preview`) {
  let closed!: () => void;
  const terminal = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer((request, response) => {
    const task = observePreviewHttp(request, response, async () => {
      const controller = new AbortController();
      response.once('close', () => {
        if (!response.writableFinished) controller.abort(Error(secret));
        closed();
      });
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(',') : value);
      // The fixture supplies decoded route params without starting Next.
      const requestedId = decodeURIComponent(
        new URL(request.url!, 'http://localhost').pathname.split('/').at(-2)!,
      );
      const result = await GET(
        new Request(`http://localhost${request.url}`, {
          headers,
          signal: controller.signal,
          method: request.method,
        }),
        { params: Promise.resolve({ id: requestedId }) },
      );
      if (response.destroyed) return;
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    });
    tasks.push(task);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('missing listener');
  return {
    url: `http://127.0.0.1:${address.port}${path}?workspaceId=${workspace}&token=credential`,
    terminal,
  };
}

it.each([
  ['GET', '/api/health/live'],
  ['POST', `/api/v1/workbench/files/${id}/preview`],
])(
  'leaves the existing handler and headers untouched for %s %s',
  async (method, path) => {
    const forged = '10000000-0000-4000-8000-000000000001';
    let observed: Record<string, string | string[] | undefined> = {};
    const server = createServer((request, response) => {
      observePreviewHttp(request, response, () => {
        observed = request.headers;
        response.writeHead(202);
        response.end('existing handler');
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('missing listener');
    const result = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: {
        [previewRequestHeader]: forged,
        [previewStartedHeader]: '0',
        'x-client-fixture': 'ordinary header',
      },
    });
    expect(result.status).toBe(202);
    expect(await result.text()).toBe('existing handler');
    expect(observed[previewRequestHeader]).toBe(forged);
    expect(observed[previewStartedHeader]).toBe('0');
    expect(observed['x-client-fixture']).toBe('ordinary header');
    expect(records()).toEqual([]);
  },
);

it('previews the selected DOCX through the real GET and static reader, correlating a complete HTTP response without leaking input', async () => {
  const f = await fixture(),
    forged = '10000000-0000-4000-8000-000000000001';
  const result = await fetch(f.url, {
    headers: {
      [previewRequestHeader]: forged,
      [previewStartedHeader]: '0',
      authorization: 'credential',
    },
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    kind: 'pdf',
    missingFonts: ['Noto Sans CJK SC'],
    converted: true,
  });
  await f.terminal;
  expect(ports.file).toHaveBeenCalledTimes(2);
  expect(ports.read).toHaveBeenCalledTimes(1);
  const events = records();
  expect(new Set(events.map((entry) => entry.requestId)).size).toBe(1);
  expect(events[0]!.requestId).not.toBe(forged);
  expect(events.filter((entry) => entry.event === 'finish')).toMatchObject([
    { stage: 'http', status: 200, aborted: false },
  ]);
  expect(events.filter((entry) => entry.event === 'close')).toMatchObject([
    { stage: 'http', status: 200, aborted: false },
  ]);
  for (const stage of [
    'authorize-before',
    'object-read',
    'office-conversion',
    'authorize-after',
  ]) {
    expect(
      events
        .filter((entry) => entry.stage === stage)
        .map((entry) => entry.event),
    ).toEqual(['start', 'end']);
  }
  expect(events.some((entry) => entry.event === 'constructed')).toBe(true);
  expect(
    events.findIndex((entry) => entry.event === 'constructed'),
  ).toBeLessThan(events.findIndex((entry) => entry.event === 'finish'));
  expect(
    events.every(
      (entry) => typeof entry.elapsedMs === 'number' && entry.elapsedMs >= 0,
    ),
  ).toBe(true);
  expect(
    events
      .filter((entry) => entry.event === 'end')
      .every(
        (entry) =>
          typeof entry.durationMs === 'number' &&
          entry.durationMs >= 0 &&
          entry.outcome === 'ok',
      ),
  ).toBe(true);
  expect(JSON.stringify(events)).not.toContain(id);
  for (const value of [
    secret,
    'private.invalid',
    'credential',
    'private-name',
    '/api/v1/',
  ])
    expect(JSON.stringify(events)).not.toContain(value);
  expect(
    events
      .filter((entry) => entry.objectHash !== undefined)
      .every(
        (entry) =>
          entry.objectHash === createHash('sha256').update(id).digest('hex'),
      ),
  ).toBe(true);
});

it('returns the existing download_only JSON for a failed live conversion and safely records its cause', async () => {
  ports.office.mockRejectedValue(
    Object.assign(Error(secret), { name: 'OfficeToPdfError', code: 'timeout' }),
  );
  const f = await fixture();
  const result = await fetch(f.url);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ kind: 'download_only' });
  await f.terminal;
  expect(ports.file).toHaveBeenCalledTimes(2);
  expect(records().some((entry) => entry.event === 'failure')).toBe(true);
  expect(JSON.stringify(errorCalls)).not.toContain(secret);
});

it.each([
  ['not-a-uuid', 'GET', 400],
  [id.replace('0', '%30'), 'GET', 200],
  [id, 'HEAD', 200],
] as const)(
  'ignores client diagnostic headers on an unobserved %s %s entry',
  async (routeId, method, status) => {
    const forged = '10000000-0000-4000-8000-000000000001';
    const f = await fixture(`/api/v1/workbench/files/${routeId}/preview`);
    const result = await fetch(f.url, {
      method,
      headers: { [previewRequestHeader]: forged, [previewStartedHeader]: '0' },
    });
    expect(result.status).toBe(status);
    await result.text();
    await f.terminal;
    expect(records().some((entry) => entry.stage === 'authorize-before')).toBe(
      true,
    );
    expect(records().some((entry) => entry.stage === 'http')).toBe(false);
    expect(new Set(records().map((entry) => entry.requestId)).size).toBe(1);
    expect(JSON.stringify(records())).not.toContain(forged);
  },
);

it('uses a fresh UUID and clock when GET runs without the custom-server scope', async () => {
  const forged = '10000000-0000-4000-8000-000000000001';
  const request = new Request(`http://localhost/?workspaceId=${workspace}`, {
    headers: { [previewRequestHeader]: forged, [previewStartedHeader]: '0' },
  });
  const headers = vi.spyOn(request.headers, 'get');
  expect(activePreviewDiagnostics()).toBeUndefined();
  const before = performance.now();
  const { diagnostic, dispose } = previewRequestDiagnostics(request);
  expect(diagnostic.requestId).not.toBe(forged);
  expect(diagnostic.started).toBeGreaterThanOrEqual(before);
  dispose();
  const response = await GET(request, { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ kind: 'pdf' });
  expect(JSON.stringify(records())).not.toContain(forged);
  expect(headers).not.toHaveBeenCalledWith(previewRequestHeader);
  expect(headers).not.toHaveBeenCalledWith(previewStartedHeader);
});

it('shares live request context across independently loaded Node module instances', async () => {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), 'preview-context-'),
  );
  directories.push(directory);
  const copy = join(directory, 'independent.mjs');
  await writeFile(
    copy,
    await readFile(
      new URL(
        '../../../../../../../server/preview-diagnostics.mjs',
        import.meta.url,
      ),
    ),
  );
  const independent = createRequire(import.meta.url)(
    copy,
  ) as typeof PreviewDiagnosticsModule;
  expect(independent.activePreviewDiagnostics).not.toBe(
    activePreviewDiagnostics,
  );
  const convert = ports.office.getMockImplementation()!;
  ports.office.mockImplementation(async (input) => {
    const diagnostic = activePreviewDiagnostics();
    expect(diagnostic).toBeDefined();
    expect(independent.activePreviewDiagnostics()).toBe(diagnostic);
    await Promise.resolve();
    expect(independent.activePreviewDiagnostics()).toBe(diagnostic);
    return convert(input);
  });
  const f = await fixture();
  const response = await fetch(f.url);
  expect(response.status).toBe(200);
  await response.text();
  await f.terminal;
  expect(activePreviewDiagnostics()).toBeUndefined();
  expect(independent.activePreviewDiagnostics()).toBeUndefined();
});

it('keeps two overlapping previews associated when the second one completes first', async () => {
  const otherId = '00000000-0000-4000-8000-000000000902';
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const first = { entered: deferred(), release: deferred() };
  const second = { entered: deferred(), release: deferred() };
  const associations: Record<string, string> = {};
  const convert = ports.office.getMockImplementation()!;
  ports.file.mockImplementation(async (_context, objectId) => ({
    ...storedFile,
    object: { ...storedFile.object, id: objectId },
  }));
  ports.office.mockImplementation(async (input) => {
    const diagnostic = activePreviewDiagnostics();
    if (!diagnostic) throw Error('Missing preview context');
    associations[input.objectId] = diagnostic.requestId;
    const gate = input.objectId === id ? first : second;
    const aborted = () => gate.release.resolve();
    input.signal.addEventListener('abort', aborted, { once: true });
    gate.entered.resolve();
    try {
      await gate.release.promise;
      input.signal.throwIfAborted();
      expect(activePreviewDiagnostics()).toBe(diagnostic);
      return await convert(input);
    } finally {
      input.signal.removeEventListener('abort', aborted);
    }
  });
  const f = await fixture();
  const firstResponse = fetch(f.url);
  const secondResponse = fetch(f.url.replace(id, otherId));
  try {
    await Promise.all([first.entered.promise, second.entered.promise]);
    second.release.resolve();
    expect((await secondResponse).status).toBe(200);
    await (await secondResponse).text();
    expect(
      records()
        .filter((entry) => entry.event === 'constructed')
        .map((entry) => entry.objectHash),
    ).toEqual([createHash('sha256').update(otherId).digest('hex')]);
    first.release.resolve();
    expect((await firstResponse).status).toBe(200);
    await (await firstResponse).text();
    expect(associations[id]).not.toBe(associations[otherId]);
    for (const objectId of [id, otherId]) {
      const events = records().filter(
        (entry) =>
          entry.objectHash ===
          createHash('sha256').update(objectId).digest('hex'),
      );
      expect(new Set(events.map((entry) => entry.requestId))).toEqual(
        new Set([associations[objectId]]),
      );
      expect(events.filter((entry) => entry.event === 'finish')).toHaveLength(
        1,
      );
      expect(
        ports.file.mock.calls.filter(([, requested]) => requested === objectId),
      ).toHaveLength(2);
    }
    expect(activePreviewDiagnostics()).toBeUndefined();
  } finally {
    first.release.resolve();
    second.release.resolve();
    await Promise.allSettled([firstResponse, secondResponse]);
  }
});

it('preserves cancellation when the client closes first, without reporting a finished or download-only response', async () => {
  let entered!: () => void;
  const converting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  ports.office.mockImplementation(
    (input) =>
      new Promise((_, reject) => {
        input.signal.addEventListener(
          'abort',
          () => reject(input.signal.reason),
          { once: true },
        );
        entered();
      }),
  );
  const f = await fixture();
  const request = httpRequest(f.url);
  request.on('error', () => {});
  request.end();
  await converting;
  request.destroy();
  await f.terminal;
  await Promise.all(tasks);
  expect(ports.file).toHaveBeenCalledTimes(1);
  expect(records().filter((entry) => entry.event === 'close')).toMatchObject([
    { aborted: true },
  ]);
  expect(records().some((entry) => entry.event === 'finish')).toBe(false);
  expect(records().some((entry) => entry.event === 'abort')).toBe(true);
  expect(
    records().filter((entry) => entry.event === 'constructed'),
  ).toMatchObject([{ status: 500, aborted: true }]);
  expect(JSON.stringify(errorCalls)).not.toContain(secret);
});

it('keeps an already aborted request out of the download-only fallback and storage read', async () => {
  const controller = new AbortController();
  controller.abort(Error(secret));
  const request = new Request('http://localhost/?workspaceId=' + workspace, {
    signal: controller.signal,
  });
  const result = await GET(request, { params: Promise.resolve({ id }) });
  expect(result.status).toBe(500);
  expect(await result.text()).not.toContain('download_only');
  expect(ports.file).toHaveBeenCalledTimes(1);
  expect(ports.read).not.toHaveBeenCalled();
  expect(ports.office.mock.calls[0]![0].signal).toBe(request.signal);
  expect(JSON.stringify(errorCalls)).not.toContain(secret);
});

it.each(['before', 'after'])(
  'keeps the %s-conversion permission denial and discloses no rendered bytes',
  async (when) => {
    if (when === 'before')
      ports.file.mockRejectedValueOnce(new DataAccessError('not_found'));
    else
      ports.file
        .mockResolvedValueOnce(storedFile)
        .mockRejectedValueOnce(new DataAccessError('not_found'));
    const f = await fixture();
    const result = await fetch(f.url);
    expect(result.status).toBe(404);
    expect(await result.text()).not.toContain('PDF');
    await f.terminal;
    expect(ports.office).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
    expect(JSON.stringify(records())).not.toContain(id);
  },
);

it('uses the safe callback for unexpected preview errors while preserving shared storage classifications and default logging', async () => {
  ports.file.mockRejectedValueOnce(
    Object.assign(
      Error(secret, {
        cause: Object.assign(Error(secret), { name: secret, code: secret }),
      }),
      { name: secret, code: secret },
    ),
  );
  const f = await fixture();
  const result = await fetch(f.url);
  expect(result.status).toBe(500);
  expect(await result.json()).toMatchObject({ error: expect.anything() });
  await f.terminal;
  expect(
    errorCalls.some(([label]) => label === 'Unhandled storage request error'),
  ).toBe(false);
  expect(JSON.stringify(errorCalls)).not.toContain(secret);
  const callback = vi.fn();
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(id);
  for (const known of [
    ...(
      [
        'authentication_required',
        'authorization_denied',
        'not_found',
        'quota_exceeded',
        'grant_invalid',
      ] as const
    ).map((code) => new DataAccessError(code)),
    new WorkbenchFileError('invalid_file', 'Invalid file'),
    new WorkbenchFileError('version_conflict', 'Version changed'),
    new ReferenceLibraryError('invalid_content'),
    new ReferenceLibraryError('version_conflict'),
    new ArtifactReviewError('preview_too_large'),
    new ArtifactReviewError('identity_denied'),
    new ArtifactReviewError('content_changed'),
  ]) {
    const original = workbenchFileError(known);
    const redirected = workbenchFileError(known, {
      onUnexpectedError: callback,
    });
    expect(redirected.status).toBe(original.status);
    expect(await redirected.json()).toEqual(await original.json());
  }
  expect(callback).not.toHaveBeenCalled();
  storageErrorResponse(Error(secret));
  expect(errorCalls.at(-1)).toEqual([
    'Unhandled storage request error',
    { name: 'Error', message: secret },
  ]);
});
