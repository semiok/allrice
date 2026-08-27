import {
  DataAccessError,
  cancelCodexAuthorization,
  getCodexAuthorization,
  startCodexAuthorization,
} from '@allrice/database';

import { getRequestContext } from '../../../../../../../lib/identity/session';
import { skillHubErrorResponse } from '../../../../../../../lib/skillhub/responses';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const flowId = new URL(request.url).searchParams.get('flowId');
    return Response.json({
      authorization: await getCodexAuthorization(context, flowId ?? undefined),
    });
  } catch (error) {
    return skillHubErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const input = await request.json().catch(() => ({}));
    return Response.json(
      { authorization: await startCodexAuthorization(context, input) },
      { status: 202 },
    );
  } catch (error) {
    return skillHubErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const flowId = new URL(request.url).searchParams.get('flowId');
    if (!flowId) throw new DataAccessError('not_found');
    return Response.json({
      authorization: await cancelCodexAuthorization(context, flowId),
    });
  } catch (error) {
    return skillHubErrorResponse(error);
  }
}
