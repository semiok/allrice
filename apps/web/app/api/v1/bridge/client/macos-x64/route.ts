import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { DataAccessError } from '@allrice/database';

import { bridgeErrorResponse } from '../../../../../../lib/bridge/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const path = process.env.ALLRICE_BRIDGE_MACOS_X64_PATH;
    if (!path) throw new DataAccessError('not_found');
    const file = await stat(path);
    const body = Readable.toWeb(createReadStream(path)) as ReadableStream;
    return new Response(body, {
      headers: {
        'cache-control': 'private, no-store',
        'content-disposition': 'attachment; filename="RiceBridge-Intel.zip"',
        'content-length': String(file.size),
        'content-type': 'application/zip',
      },
    });
  } catch (error) {
    return bridgeErrorResponse(error);
  }
}
