import { createHash } from 'node:crypto';

import { CreateFileInputSchema } from '@allrice/contracts';
import {
  DataAccessError,
  abandonStorageMetadata,
  createStorageMetadata,
  markStorageReady,
  newStorageObjectId,
  listWorkspaceFiles,
} from '@allrice/database';

import { getRequestContext } from '../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../lib/storage/responses';
import { getStorageAdapter } from '../../../../lib/storage/runtime';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    return Response.json({
      files: await listWorkspaceFiles(context, workspaceId),
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

function decodeBase64(input: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input) || input.length % 4 !== 0) {
    throw new Error('contentBase64 is invalid');
  }
  return Buffer.from(input, 'base64');
}

export async function POST(request: Request) {
  let context;
  let objectId: string | undefined;
  try {
    context = await getRequestContext(request);
    if (!context) {
      throw new DataAccessError('authentication_required');
    }
    const input = CreateFileInputSchema.parse(await request.json());
    const content = decodeBase64(input.contentBase64);
    objectId = newStorageObjectId();
    const pending = await createStorageMetadata(context, {
      id: objectId,
      workspaceId: input.workspaceId,
      category: input.category,
      mediaType: input.mediaType,
      sizeBytes: content.byteLength,
      checksum: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      visibility: input.visibility,
      retentionUntil: input.retentionUntil,
      immutable: input.immutable,
    });
    await getStorageAdapter().put(pending.object, new Blob([content]).stream());
    const stored = await markStorageReady(context, objectId);
    return Response.json({ file: stored }, { status: 201 });
  } catch (error) {
    if (context && objectId) {
      await abandonStorageMetadata(context, objectId).catch(() => undefined);
    }
    return storageErrorResponse(error);
  }
}
