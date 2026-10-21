import { UuidSchema } from '@allrice/contracts';
import {
  workbenchFileContext,
  workbenchFileError,
  workbenchFileHeaders,
} from '../../../../../../../lib/workbench-files';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { captureWorkbenchFileReference } from '@allrice/database';
import { getStorageAdapter } from '../../../../../../../lib/storage/runtime';
import { z } from 'zod';
export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await workbenchFileContext(request, true),
      { id } = await route.params;
    const input = z
      .object({ requestId: UuidSchema })
      .strict()
      .parse(await request.json());
    const reference = await captureWorkbenchFileReference(
      context,
      context.workspaceId,
      UuidSchema.parse(id),
      input.requestId,
      getStorageAdapter(),
    );
    return Response.json({ reference }, { headers: workbenchFileHeaders });
  } catch (error) {
    return workbenchFileError(error);
  }
}
