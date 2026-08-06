import { createHash } from 'node:crypto';

import {
  CreateSessionAttachmentInputSchema,
  LinkSessionAttachmentInputSchema,
} from '@allrice/contracts';
import {
  DataAccessError,
  abandonStorageMetadata,
  authorizeSessionOwner,
  createStorageMetadata,
  linkFileToSession,
  linkWorkspaceFileToSession,
  markStorageReady,
  newStorageObjectId,
} from '@allrice/database';

import { getRequestContext } from '../../../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../../../lib/storage/responses';
import { getStorageAdapter } from '../../../../../../lib/storage/runtime';

export const runtime = 'nodejs';

function decodeBase64(input: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input) || input.length % 4 !== 0) {
    throw new Error('contentBase64 is invalid');
  }
  return Buffer.from(input, 'base64');
}

export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  let context;
  let objectId: string | undefined;
  try {
    context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id: sessionId } = await route.params;
    await authorizeSessionOwner(context, workspaceId, sessionId);
    const input = CreateSessionAttachmentInputSchema.parse(
      await request.json(),
    );
    const content = decodeBase64(input.contentBase64);
    objectId = newStorageObjectId();
    const pending = await createStorageMetadata(context, {
      id: objectId,
      workspaceId,
      category: 'uploads',
      mediaType: input.mediaType,
      sizeBytes: content.byteLength,
      checksum: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      visibility: input.visibility,
      retentionUntil: null,
      immutable: false,
    });
    await getStorageAdapter().put(pending.object, new Blob([content]).stream());
    const stored = await markStorageReady(context, objectId);
    await linkFileToSession({
      context,
      workspaceId,
      sessionId,
      objectId,
      fileName: input.fileName,
    });
    return Response.json(
      {
        attachment: {
          id: objectId,
          fileName: input.fileName,
          mediaType: stored.object.mediaType,
          sizeBytes: stored.object.sizeBytes,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (context && objectId) {
      await abandonStorageMetadata(context, objectId).catch(() => undefined);
    }
    return storageErrorResponse(error);
  }
}

export async function PUT(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id: sessionId } = await route.params;
    const input = LinkSessionAttachmentInputSchema.parse(await request.json());
    const linked = await linkWorkspaceFileToSession({
      context,
      workspaceId,
      sessionId,
      objectId: input.objectId,
    });
    return Response.json({ attachment: linked });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
