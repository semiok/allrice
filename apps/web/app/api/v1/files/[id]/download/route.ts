import { DataAccessError, getStoredFile } from '@allrice/database';

import { getRequestContext } from '../../../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../../../lib/storage/responses';
import { getStorageAdapter } from '../../../../../../lib/storage/runtime';

export const runtime = 'nodejs';

function downloadName(request: Request) {
  const raw = new URL(request.url).searchParams.get('name') ?? 'allrice-export';
  let sanitized = '';
  for (const character of raw) {
    const safe =
      character === '\\' || character === '/' || character.charCodeAt(0) < 32
        ? '-'
        : character;
    if (sanitized.length + safe.length > 255) break;
    sanitized += safe;
  }
  return sanitized || 'allrice-export';
}

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await route.params;
    const file = await getStoredFile(context, id);
    const name = downloadName(request);
    return new Response(await getStorageAdapter().get(file.object), {
      headers: {
        'Content-Type': file.object.mediaType,
        'Content-Length': String(file.object.sizeBytes),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
