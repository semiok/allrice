import { readFile } from 'node:fs/promises';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { nativeExcelAssetResponse } from './native-document-asset';

const request = (encoding?: string, etag?: string) =>
  new Request('http://fixture/api/dsh-ui/excel', {
    headers: {
      ...(encoding === undefined ? {} : { 'accept-encoding': encoding }),
      ...(etag === undefined ? {} : { 'if-none-match': etag }),
    },
  });
describe('exact upstream Excel software asset transport', () => {
  it('compresses the exact pinned original including its worker and notices, with separate cache variants', async () => {
    const expected = await readFile(
      'apps/web/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.excel.js',
    );
    const [identity, gzip, br] = await Promise.all([
      nativeExcelAssetResponse(request()),
      nativeExcelAssetResponse(request('gzip')),
      nativeExcelAssetResponse(request('gzip, br')),
    ]);
    const raw = Buffer.from(await identity.arrayBuffer()),
      gz = Buffer.from(await gzip.arrayBuffer()),
      brotli = Buffer.from(await br.arrayBuffer());
    expect(raw.equals(expected)).toBe(true);
    expect(gunzipSync(gz).equals(expected)).toBe(true);
    expect(brotliDecompressSync(brotli).equals(expected)).toBe(true);
    expect(gzip.headers.get('content-encoding')).toBe('gzip');
    expect(br.headers.get('content-encoding')).toBe('br');
    expect(gz.length).toBeLessThan(raw.length / 3);
    expect(brotli.length).toBeLessThan(gz.length);
    for (const [response, bytes] of [
      [identity, raw],
      [gzip, gz],
      [br, brotli],
    ] as const) {
      expect(response.headers.get('vary')).toBe('Accept-Encoding');
      expect(Number(response.headers.get('content-length'))).toBe(bytes.length);
      expect(response.headers.get('content-type')).toBe(
        'text/javascript; charset=utf-8',
      );
    }
    expect(
      new Set([identity, gzip, br].map((r) => r.headers.get('etag'))).size,
    ).toBe(3);
    const notModified = await nativeExcelAssetResponse(
      request('gzip, br', 'W/' + br.headers.get('etag')),
    );
    expect(notModified.status).toBe(304);
    expect((await notModified.arrayBuffer()).byteLength).toBe(0);
    expect(
      (
        await nativeExcelAssetResponse(
          request('identity', br.headers.get('etag')!),
        )
      ).status,
    ).toBe(200);
  });
  it.each([
    ['gzip;q=0, br;q=0', null],
    ['gzip;q=0.5, identity;q=1', null],
    ['*;q=0, gzip;q=1', 'gzip'],
    ['br;q=0, gzip', 'gzip'],
    ['gzip;q=0.5, br;q=1', 'br'],
    ['gzip;q=garbage', null],
  ])('honors encoding preferences %s', async (encoding, expected) => {
    const response = await nativeExcelAssetResponse(request(encoding));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe(expected);
  });
  it('does not send a representation when all supported encodings were explicitly rejected', async () => {
    expect((await nativeExcelAssetResponse(request('*;q=0'))).status).toBe(406);
  });
});
