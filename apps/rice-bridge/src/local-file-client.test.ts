import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFileObjectSchema } from '@allrice/contracts';
import { localFileHttpTransport } from './local-file-client.js';
import { executeLocalFile, inspectLocalFile } from './local-files.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function folder() {
  const path = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-file-http-')),
  );
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw Error('owned loopback missing');
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  return `http://127.0.0.1:${address.port}`;
}
describe('native file streams use real fetch cancellation and lost-ACK uncertainty', () => {
  it('aborts a blocked download reader and removes the temporary local file', async () => {
    const root = await folder(),
      bytes = Buffer.from('%PDF synthetic stalled bytes');
    const object = LocalFileObjectSchema.parse({
      objectId: randomUUID(),
      fileName: '停住.pdf',
      mediaType: 'application/pdf',
      sizeBytes: bytes.length,
      checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
    const canceled = new AbortController();
    let downloadClosed = false,
      started!: () => void;
    const downloadStarted = new Promise<void>((r) => {
      started = r;
    });
    const server = await listen(
      createServer((request, response) => {
        if (request.url?.includes('authorize'))
          return response.end(JSON.stringify({ authorized: true }));
        response.writeHead(200, {
          'content-length': bytes.length,
          'x-allrice-checksum': object.checksum,
        });
        response.write(bytes.subarray(0, 3));
        response.on('close', () => {
          downloadClosed = true;
        });
        started();
      }),
    );
    const channel = localFileHttpTransport({
      server,
      token: 'synthetic',
      kind: 'command',
      id: randomUUID(),
      leaseToken: randomUUID(),
      signal: canceled.signal,
    });
    const execution = executeLocalFile(
      root,
      {
        capability: 'local.file.save',
        arguments: { path: '停住.pdf', object },
      },
      { ...channel, signal: canceled.signal },
    );
    const rejected = expect(execution).rejects.toThrow();
    await downloadStarted;
    canceled.abort();
    await rejected;
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(downloadClosed).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });
  it('keeps uploaded bytes as unknown when the server loses the acknowledgement, without replay', async () => {
    const root = await folder(),
      path = '资料 空格.xlsx',
      bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff, 0xfe]);
    await writeFile(join(root, path), bytes);
    const expected = await inspectLocalFile(root, path);
    const object = LocalFileObjectSchema.parse({
      objectId: randomUUID(),
      fileName: path,
      checksum: expected.checksum,
      sizeBytes: expected.sizeBytes,
      mediaType: expected.mediaType,
    });
    let uploads = 0,
      received: Buffer | null = null;
    const server = await listen(
      createServer(async (request, response) => {
        if (request.url?.includes('authorize'))
          return response.end(JSON.stringify({ authorized: true }));
        uploads++;
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        received = Buffer.concat(chunks);
        response.destroy();
      }),
    );
    const channel = localFileHttpTransport({
      server,
      token: 'synthetic',
      kind: 'command',
      id: randomUUID(),
      leaseToken: randomUUID(),
    });
    await expect(
      executeLocalFile(
        root,
        {
          capability: 'local.file.import',
          arguments: { path, expected, object },
        },
        channel,
      ),
    ).rejects.toMatchObject({ code: 'FILE_UPLOAD_UNKNOWN', unknown: true });
    expect(received).toEqual(bytes);
    expect(uploads).toBe(1);
    expect(await readFile(join(root, path))).toEqual(bytes);
  });
});
