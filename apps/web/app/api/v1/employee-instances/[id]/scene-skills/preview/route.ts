import { DataAccessError } from '@allrice/database';
import { getRequestContext } from '../../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../../lib/identity/request-origin';
import { previewPersonalSceneSource } from '../../../../../../../lib/skills/personal-scene-confirm';
import { readSkillPreviewRequest } from '../../../../../../../lib/skills/preview-request';
import {
  sceneSourceErrorResponse,
  sceneSourceHeaders,
} from '../../../../../../../lib/skills/scene-source-response';

export const runtime = 'nodejs';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { input, archive } = await readSkillPreviewRequest(request);
    return Response.json(
      await previewPersonalSceneSource(
        context,
        (await params).id,
        input,
        archive,
        request.signal,
      ),
      { headers: sceneSourceHeaders },
    );
  } catch (error) {
    return sceneSourceErrorResponse(error, 'preview');
  }
}
