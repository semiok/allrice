import { UuidSchema } from '@allrice/contracts';
import {
  workbenchFileContext,
  workbenchFileError,
  workbenchFileHeaders,
} from '../../../../../../../lib/workbench-files';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { readWorkbenchFile } from '@allrice/database';
import { getStorageAdapter } from '../../../../../../../lib/storage/runtime';
export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await workbenchFileContext(request),
      { id } = await route.params;
    const file = await readWorkbenchFile(context, UuidSchema.parse(id));
    const stream = await getStorageAdapter().get(file.object);
    await readWorkbenchFile(context, id);
    const name =
      [...file.row.file_name]
        .map((character) =>
          character === '\\' ||
          character === '/' ||
          character.charCodeAt(0) < 32 ||
          character.charCodeAt(0) === 127
            ? '-'
            : character,
        )
        .join('')
        .slice(0, 160) || 'allrice-file';
    return new Response(stream, {
      headers: {
        ...workbenchFileHeaders,
        'Content-Type': file.object.mediaType,
        'Content-Length': String(file.object.sizeBytes),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    });
  } catch (error) {
    return workbenchFileError(error);
  }
}
