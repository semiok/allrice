import { changeReference } from '@allrice/database';
import {
  referenceContext,
  referenceError,
  referenceHeaders,
} from '../../../../../lib/reference-library';
export const runtime = 'nodejs';
export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    return Response.json(
      await changeReference(
        await referenceContext(request),
        (await route.params).id,
        await request.json(),
      ),
      { headers: referenceHeaders },
    );
  } catch (error) {
    return referenceError(error);
  }
}
