import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const compress = promisify(gzip);
const brotli = promisify(brotliCompress);
type Asset = { bytes: Buffer; gzip: Buffer; br: Buffer; checksum: string };
let cached: Promise<Asset> | undefined;

/** One exact upstream chunk per immutable release process. Compression changes
 * transport bytes only, not the DSH parser, worker or license notices. */
function excelAsset() {
  if (!cached) {
    cached = (async () => {
      const path =
        'node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.excel.js';
      const bytes = await readFile(join(process.cwd(), path)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return readFile(join(process.cwd(), 'apps/web', path));
        },
      );
      const [gz, br] = await Promise.all([
        compress(bytes),
        brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
      ]);
      return {
        bytes,
        gzip: gz,
        br,
        checksum: createHash('sha256').update(bytes).digest('hex'),
      };
    })().catch((error) => {
      cached = undefined;
      throw error;
    });
  }
  return cached;
}

function encoding(value: string | null): 'gzip' | 'br' | 'identity' | null {
  const preferences = new Map<string, number>();
  for (const item of (value ?? '').split(',')) {
    const [name, ...params] = item.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params
      .find((p) => p.trim().startsWith('q='))
      ?.trim()
      .slice(2);
    const quality =
      q === undefined
        ? 1
        : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q)
          ? Number(q)
          : 0;
    preferences.set(name.trim(), quality);
  }
  const quality = (name: string) =>
    preferences.get(name) ?? preferences.get('*') ?? 0;
  const identity =
    preferences.get('identity') ?? (preferences.get('*') === 0 ? 0 : 1);
  const candidates = ['br', 'gzip'] as const;
  const selected = candidates
    .filter(
      (name) =>
        quality(name) > 0 &&
        quality(name) >= (preferences.get('identity') ?? 0),
    )
    .sort((a, b) => quality(b) - quality(a))[0];
  return selected ?? (identity > 0 ? 'identity' : null);
}

export async function nativeExcelAssetResponse(request: Request) {
  const asset = await excelAsset();
  const selected = encoding(request.headers.get('accept-encoding'));
  if (!selected)
    return new Response(null, {
      status: 406,
      headers: { Vary: 'Accept-Encoding' },
    });
  const etag = `"${asset.checksum}-${selected}"`;
  const headers: Record<string, string> = {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Accept-Encoding',
    ETag: etag,
    ...(selected === 'identity' ? {} : { 'Content-Encoding': selected }),
  };
  const matches = request.headers
    .get('if-none-match')
    ?.split(',')
    .some(
      (item) => item.trim() === '*' || item.trim().replace(/^W\//, '') === etag,
    );
  if (matches) return new Response(null, { status: 304, headers });
  const bytes = selected === 'identity' ? asset.bytes : asset[selected];
  return new Response(new Uint8Array(bytes), {
    headers: { ...headers, 'Content-Length': String(bytes.byteLength) },
  });
}
