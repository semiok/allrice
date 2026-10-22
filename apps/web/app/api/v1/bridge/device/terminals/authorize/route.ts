import { z } from 'zod';
import { TerminalTargetSchema } from '@allrice/contracts';
import {
  DataAccessError,
  revalidateBridgeTerminalTarget,
} from '@allrice/database';
import { readAdminJson } from '../../../../../../../lib/tenant-administration/http';
import { bridgeErrorResponse } from '../../../../../../../lib/bridge/responses';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const auth = request.headers.get('authorization');
    if (!auth || !/^Bearer [^\s]{1,256}$/.test(auth))
      throw new DataAccessError('authentication_required');
    const { target } = z
      .object({ target: TerminalTargetSchema })
      .strict()
      .parse(await readAdminJson(request, 4096));
    return Response.json(
      await revalidateBridgeTerminalTarget(auth.slice(7), target),
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    const response = bridgeErrorResponse(error);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }
}
