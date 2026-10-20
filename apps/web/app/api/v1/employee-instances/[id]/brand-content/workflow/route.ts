import { DataAccessError, startBrandContentWorkflow } from '@allrice/database';
import { getRequestContext } from '../../../../../../../lib/identity/session';
import { brandContentErrorResponse } from '../../../../../../../lib/brand-content/responses';

export const runtime = 'nodejs';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json(
      await startBrandContentWorkflow(
        context,
        (await params).id,
        await request.json(),
      ),
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return brandContentErrorResponse(error);
  }
}
