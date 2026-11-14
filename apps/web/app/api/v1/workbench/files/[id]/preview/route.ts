import { UuidSchema } from '@allrice/contracts';
import {
  workbenchFileContext,
  workbenchFileError,
  workbenchFileHeaders,
} from '../../../../../../../lib/workbench-files';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { readWorkbenchFile } from '@allrice/database';
import { readStaticArtifactPreview } from '../../../../../../../lib/runtime/static-artifact-preview';
import {
  previewPhase,
  previewRequestDiagnostics,
  reportPreviewFailure,
} from '../../../../../../../lib/runtime/preview-diagnostics';
export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { diagnostic, dispose } = previewRequestDiagnostics(request);
  let response: Response;
  try {
    const { context, id, params, file } = await previewPhase(
      diagnostic,
      'authorize-before',
      async () => {
        const context = await workbenchFileContext(request),
          { id } = await route.params,
          params = new URL(request.url).searchParams;
        diagnostic.object(id);
        const file = await readWorkbenchFile(context, UuidSchema.parse(id));
        return { context, id, params, file };
      },
    );
    const preview = await readStaticArtifactPreview(
      {
        object: file.object,
        kind: 'file',
        version: { fileName: file.row.file_name },
      },
      {
        offset: Number(params.get('offset') ?? 1),
        source: params.get('source') === '1',
        signal: request.signal,
        diagnostic,
      },
    );
    await previewPhase(diagnostic, 'authorize-after', () =>
      readWorkbenchFile(context, id),
    );
    response = Response.json(preview, { headers: workbenchFileHeaders });
  } catch (error) {
    response = workbenchFileError(error, {
      onUnexpectedError: (failure) =>
        reportPreviewFailure(
          'artifact-request',
          failure,
          undefined,
          diagnostic,
        ),
    });
  } finally {
    dispose();
  }
  diagnostic.emit('constructed', 'response', {
    status: response.status,
    aborted: request.signal.aborted,
  });
  return response;
}
