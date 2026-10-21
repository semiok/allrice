import { WorkbenchFileCatalogSchema, UuidSchema } from '@allrice/contracts';
import {
  readWorkbenchFileCatalog,
  uploadWorkbenchFile,
} from '@allrice/database';
import { z } from 'zod';
import {
  workbenchFileContext,
  workbenchFileError,
  workbenchFileHeaders,
} from '../../../../../lib/workbench-files';
import { getStorageAdapter } from '../../../../../lib/storage/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const context = await workbenchFileContext(request),
      params = new URL(request.url).searchParams;
    const input = {
      workspaceId: context.workspaceId,
      sessionId: params.get('sessionId')
        ? UuidSchema.parse(params.get('sessionId'))
        : null,
      scope: z
        .enum(['all', 'current', 'my', 'departments', 'company'])
        .parse(params.get('scope') ?? 'all'),
      query: z
        .string()
        .max(200)
        .parse(params.get('query') ?? ''),
    };
    return Response.json(
      WorkbenchFileCatalogSchema.parse(
        await readWorkbenchFileCatalog(context, input),
      ),
      { headers: workbenchFileHeaders },
    );
  } catch (error) {
    return workbenchFileError(error);
  }
}
export async function POST(request: Request) {
  try {
    const context = await workbenchFileContext(request, true);
    const result = await uploadWorkbenchFile(
      context,
      await request.json(),
      getStorageAdapter(),
    );
    return Response.json(result, {
      status: 201,
      headers: workbenchFileHeaders,
    });
  } catch (error) {
    return workbenchFileError(error);
  }
}
