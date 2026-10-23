import { UuidSchema } from '@allrice/contracts';
import { WorkbenchFileActionsCatalogSchema } from '../../../../../lib/chatflow/workbench-file-actions';
import {
  readWorkbenchFileCatalog,
  uploadWorkbenchFile,
  isIndexableKnowledgeTextSource,
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
    const catalog = WorkbenchFileActionsCatalogSchema.parse(
      await readWorkbenchFileCatalog(context, input),
    );
    // This only projects existing processing capabilities; reference preparation
    // still checks current authority and exact bytes on the original endpoint.
    const quotableFileIds = catalog.files
      .filter((file) => {
        if (file.reference?.companyTemplate) return true;
        const current =
          file.reference?.checksum === file.checksum ? file.reference : null;
        if (current?.status === 'archived') return false;
        if (current?.processing === 'ready') return true;
        if (
          current &&
          ['unsupported', 'failed', 'uploading'].includes(current.processing)
        )
          return false;
        return isIndexableKnowledgeTextSource(file);
      })
      .map((file) => file.objectId);
    return Response.json(
      { ...catalog, quotableFileIds },
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
