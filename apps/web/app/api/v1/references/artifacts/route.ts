import { referenceLibraryOptions, DataAccessError } from '@allrice/database';
import { UuidSchema } from '@allrice/contracts';
import {
  referenceContext,
  referenceError,
  referenceHeaders,
} from '../../../../../lib/reference-library';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const context = await referenceContext(request);
    const workspaceId = UuidSchema.parse(
      new URL(request.url).searchParams.get('workspaceId') ??
        context.workspaceId,
    );
    return Response.json(await referenceLibraryOptions(context, workspaceId), {
      headers: referenceHeaders,
    });
  } catch (error) {
    return referenceError(error);
  }
}
export async function POST(request: Request) {
  try {
    await referenceContext(request, true);
    throw new DataAccessError('not_found');
  } catch (error) {
    return referenceError(error);
  }
}
