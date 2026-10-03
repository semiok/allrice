import { z } from 'zod';
import {
  LocalFileVersionSchema,
  FileDerivationContentSchema,
  RuntimeLocalPythonArtifactMetadataSchema,
  UuidSchema,
} from '@allrice/contracts';
import {
  localFileTransferAuthority,
  readLocalFileDownload,
  storeLocalFileUpload,
  storeLocalFileDerivation,
  localPythonTransferAuthority,
  readLocalPythonInput,
  storeLocalPythonArtifact,
  readBridgeOperationTransferCapability,
  localPdfTransferAuthority,
  readLocalPdfInput,
  DataAccessError,
} from '@allrice/database';
import { getBridgeDeviceToken } from '../../../../../../../../lib/bridge/request';
import { bridgeErrorResponse } from '../../../../../../../../lib/bridge/responses';
import { getStorageAdapter } from '../../../../../../../../lib/storage/runtime';

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
    const url = new URL(request.url);
    if (url.searchParams.has('objectId')) {
      if (i.kind !== 'operation' || !i.token)
        throw new DataAccessError('authorization_denied');
      const objectId = UuidSchema.parse(url.searchParams.get('objectId'));
      const action = z
        .enum(['download', 'authorize'])
        .parse(url.searchParams.get('action'));
      const capability = await readBridgeOperationTransferCapability(
        i.token,
        i.id,
        i.leaseToken,
      );
      if (!['local.pdf.read', 'local.python.execute'].includes(capability))
        throw new DataAccessError('authorization_denied');
      if (action === 'download') {
        const { object } = await (
          capability === 'local.pdf.read'
            ? readLocalPdfInput
            : readLocalPythonInput
        )(i.token, i.id, i.leaseToken, objectId);
        return new Response(await getStorageAdapter().get(object), {
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(object.sizeBytes),
            'x-allrice-checksum': object.checksum,
            'cache-control': 'private, no-store',
          },
        });
      }
      await (
        capability === 'local.pdf.read'
          ? localPdfTransferAuthority
          : localPythonTransferAuthority
      )(i.token, i.id, i.leaseToken, objectId, 'authorize');
      return Response.json(
        { authorized: true },
        { headers: { 'cache-control': 'private, no-store' } },
      );
    }
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
    const url = new URL(request.url);
    if (url.searchParams.has('objectId')) {
      if (i.kind !== 'operation' || !i.token)
        throw new DataAccessError('authorization_denied');
      // Dispatch from the authenticated immutable operation. A read delegation
      // can never enter Python uploads or the legacy folder write path.
      if (
        (await readBridgeOperationTransferCapability(
          i.token,
          i.id,
          i.leaseToken,
        )) !== 'local.python.execute'
      )
        throw new DataAccessError('authorization_denied');
      const artifact = await storeLocalPythonArtifact({
        token: i.token,
        id: i.id,
        leaseToken: i.leaseToken,
        objectId: UuidSchema.parse(url.searchParams.get('objectId')),
        metadata: RuntimeLocalPythonArtifactMetadataSchema.parse(
          JSON.parse(decodeURIComponent(header)),
        ),
        stream: request.body,
        storage: getStorageAdapter(),
      });
      return Response.json(
        { artifact },
        { headers: { 'cache-control': 'private, no-store' } },
      );
    }
    if (i.kind === 'operation' && i.token) {
      const capability = await readBridgeOperationTransferCapability(
        i.token,
        i.id,
        i.leaseToken,
      );
      if (capability === 'local.pdf.read')
        throw new DataAccessError('authorization_denied');
      if (capability === 'local.file.derive') {
        const object = await storeLocalFileDerivation({
          token: i.token,
          kind: i.kind,
          id: i.id,
          leaseToken: i.leaseToken,
          metadata: FileDerivationContentSchema.parse(
            JSON.parse(decodeURIComponent(header)),
          ),
          stream: request.body,
          storage: getStorageAdapter(),
        });
        return Response.json(
          { object },
          { headers: { 'cache-control': 'private, no-store' } },
        );
      }
    }
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
