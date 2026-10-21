import { UuidSchema } from '@allrice/contracts';
import {
  readWorkbenchFileCatalog,
  getEmployeeDetails,
  listExperienceDrafts,
  experienceReviewEnabled,
} from '@allrice/database';
import {
  workbenchFileContext,
  workbenchFileError,
  workbenchFileHeaders,
} from '../../../../../lib/workbench-files';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Read-marker identities only; no private text, filenames or source excerpts. */
export async function GET(request: Request) {
  try {
    const context = await workbenchFileContext(request),
      id = new URL(request.url).searchParams.get('instanceId');
    const instanceId = id ? UuidSchema.parse(id) : null;
    const [files, experience] = await Promise.allSettled([
      readWorkbenchFileCatalog(context, { workspaceId: context.workspaceId }),
      instanceId
        ? (async () => {
            const details = await getEmployeeDetails(context, instanceId);
            const keys = details.content.sources
              .filter(
                (source) =>
                  source.available &&
                  source.reference.sourceKind === 'experience',
              )
              .map(
                (source) =>
                  source.reference.revisionId + '/' + source.reference.digest,
              );
            if (experienceReviewEnabled()) {
              const batches = await listExperienceDrafts(context, instanceId);
              for (const batch of batches)
                for (const adoption of batch.adoptions ?? [])
                  if (adoption.state === 'active')
                    keys.push(adoption.memoryId + '/' + adoption.revision);
            }
            return keys;
          })()
        : Promise.resolve([]),
    ]);
    return Response.json(
      {
        fileIds:
          files.status === 'fulfilled'
            ? files.value.files.map((file) => file.objectId)
            : null,
        experienceIds:
          experience.status === 'fulfilled' ? experience.value : null,
      },
      { headers: workbenchFileHeaders },
    );
  } catch (error) {
    return workbenchFileError(error);
  }
}
