import {
  DataAccessError,
  EmployeeQualityError,
  recordRunFeedback,
} from '@allrice/database';

import { getRequestContext } from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await route.params;
    return Response.json({
      feedback: await recordRunFeedback(context, id, await request.json()),
    });
  } catch (error) {
    if (error instanceof DataAccessError) {
      return Response.json(
        { error: { code: error.code } },
        { status: error.code === 'authentication_required' ? 401 : 403 },
      );
    }
    if (error instanceof EmployeeQualityError) {
      return Response.json({ error: { code: error.code } }, { status: 404 });
    }
    return Response.json(
      { error: { code: 'invalid_feedback' } },
      { status: 400 },
    );
  }
}
