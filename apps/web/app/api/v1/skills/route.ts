import { createHash } from 'node:crypto';

import { ImportSkillInputSchema } from '@allrice/contracts';
import {
  DataAccessError,
  abandonStorageMetadata,
  createStorageMetadata,
  listSkillHub,
  markStorageReady,
  newStorageObjectId,
  publishSkillVersion,
  SkillHubError,
} from '@allrice/database';

import { getRequestContext } from '../../../../lib/identity/session';
import { approvedSkillCandidates } from '../../../../lib/skillhub/approved-skills';
import { skillHubErrorResponse } from '../../../../lib/skillhub/responses';
import { getStorageAdapter } from '../../../../lib/storage/runtime';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new Error('workspaceId is required');
    const canAdminister =
      context.actor.type === 'user' &&
      context.memberships.some(
        (membership) =>
          membership.active &&
          membership.userId === context.actor.id &&
          membership.organizationId === context.organizationId &&
          membership.role === 'admin' &&
          (membership.workspaceId === null ||
            membership.workspaceId === workspaceId),
      );
    return Response.json({
      skillHub: await listSkillHub(context, workspaceId),
      canAdminister,
      candidates: Object.entries(approvedSkillCandidates).map(
        ([id, candidate]) => ({ id, ...candidate, bundle: undefined }),
      ),
    });
  } catch (error) {
    return skillHubErrorResponse(error);
  }
}

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof getRequestContext>> = null;
  let objectId: string | undefined;
  try {
    context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const requestContext = context;
    const body = (await request.json()) as {
      candidateId?: string;
      workspaceId?: string;
    };
    const candidate = body.candidateId
      ? approvedSkillCandidates[body.candidateId]
      : undefined;
    if (!candidate) throw new SkillHubError('artifact_invalid');
    const input = ImportSkillInputSchema.parse({
      ...candidate,
      workspaceId: body.workspaceId,
    });
    if (
      requestContext.actor.type !== 'user' ||
      !requestContext.memberships.some(
        (membership) =>
          membership.active &&
          membership.userId === requestContext.actor.id &&
          membership.organizationId === requestContext.organizationId &&
          membership.role === 'admin' &&
          (membership.workspaceId === null ||
            membership.workspaceId === input.workspaceId),
      )
    ) {
      throw new DataAccessError('authorization_denied');
    }
    const content = Buffer.from(JSON.stringify(input.bundle), 'utf8');
    if (content.byteLength > 2_000_000) {
      throw new SkillHubError('artifact_invalid');
    }
    objectId = newStorageObjectId();
    const pending = await createStorageMetadata(requestContext, {
      id: objectId,
      workspaceId: input.workspaceId,
      category: 'artifacts',
      mediaType: 'application/vnd.allrice.skill+json;v=1',
      sizeBytes: content.byteLength,
      checksum: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      visibility: 'private',
      retentionUntil: null,
      immutable: true,
    });
    await getStorageAdapter().put(pending.object, new Blob([content]).stream());
    await markStorageReady(requestContext, objectId);
    const published = await publishSkillVersion(
      requestContext,
      input,
      objectId,
    );
    return Response.json({ published }, { status: 201 });
  } catch (error) {
    if (context && objectId) {
      await abandonStorageMetadata(context, objectId).catch(() => undefined);
    }
    return skillHubErrorResponse(error);
  }
}
