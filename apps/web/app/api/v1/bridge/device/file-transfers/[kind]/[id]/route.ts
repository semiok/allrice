import { z } from 'zod';
import { LocalFileVersionSchema, UuidSchema } from '@allrice/contracts';
import {
  localFileTransferAuthority,
  readLocalFileDownload,
  storeLocalFileUpload,
  DataAccessError,
} from '@allrice/database';
import { getBridgeDeviceToken } from '../../../../../../../../lib/bridge/request.js';
import { bridgeErrorResponse } from '../../../../../../../../lib/bridge/responses.js';
import { getStorageAdapter } from '../../../../../../../../lib/storage/runtime.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Route = { params: Promise<{ kind: string; id: string }> };
const kindSchema = z.enum(['command', 'operation']);
async function identity(request: Request, route: Route) {
  const params = await route.params;
  return {
    token: getBridgeDeviceToken(request),
    kind: kindSchema.parse(params.kind),
    id: UuidSchema.parse(params.id),
    leaseToken: UuidSchema.parse(request.headers.get('x-allrice-lease')),
  };
}
export async function GET(request: Request, route: Route) {
  try {
    const i = await identity(request, route);
    if (new URL(request.url).searchParams.get('action') === 'download') {
      const object = await readLocalFileDownload(
        i.token,
        i.kind,
        i.id,
        i.leaseToken,
      );
      return new Response(await getStorageAdapter().get(object), {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(object.sizeBytes),
          'x-allrice-checksum': object.checksum,
          'cache-control': 'private, no-store',
        },
      });
    }
    await localFileTransferAuthority(i.token, i.kind, i.id, i.leaseToken);
    return Response.json(
      { authorized: true },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (e) {
    return bridgeErrorResponse(e);
  }
}
export async function POST(request: Request, route: Route) {
  try {
    const i = await identity(request, route),
      header = request.headers.get('x-allrice-file');
    if (
      !header ||
      header.length > 4096 ||
      request.headers.get('content-type') !== 'application/octet-stream' ||
      !request.body
    )
      throw new DataAccessError('authorization_denied');
    const metadata = z
      .object({
        version: LocalFileVersionSchema,
        fileName: z
          .string()
          .min(1)
          .max(255)
          .refine(
            (s) =>
              !s.includes('/') &&
              !s.includes('\\') &&
              !Array.from(s).some(
                (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
              ),
          ),
      })
      .strict()
      .parse(JSON.parse(decodeURIComponent(header)));
    const object = await storeLocalFileUpload({
      ...i,
      ...metadata,
      stream: request.body,
      storage: getStorageAdapter(),
    });
    return Response.json(
      { object },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (e) {
    return bridgeErrorResponse(e);
  }
}
