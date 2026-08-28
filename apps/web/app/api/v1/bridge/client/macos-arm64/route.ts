import { readFile } from 'node:fs/promises';

import { DataAccessError } from '@allrice/database';

import { bridgeErrorResponse } from '../../../../../../lib/bridge/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const path = process.env.ALLRICE_BRIDGE_MACOS_ARM64_PATH;
    if (!path) throw new DataAccessError('not_found');
    return new Response(await readFile(path), {
      headers: {
        'cache-control': 'private, no-store',
        'content-disposition': 'attachment; filename="RiceBridge-v0.2.zip"',
        'content-type': 'application/zip',
      },
    });
  } catch (error) {
    return bridgeErrorResponse(error);
  }
}
