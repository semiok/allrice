import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { experienceReviewEnabled, resolveWorkspaceId } from '@allrice/database';
import { getRequestContext } from '../../../lib/identity/session';
import { ExperiencePanel } from './experience-panel';
export const dynamic = 'force-dynamic';
export default async function ExperiencePage({
  searchParams,
}: {
  searchParams: Promise<{ workspaceId?: string; sessionId?: string }>;
}) {
  if (!experienceReviewEnabled()) notFound();
  const params = await searchParams;
  const context = await getRequestContext(
    new Request('http://localhost/workspace/experience', {
      headers: await headers(),
    }),
  );
  if (!context) redirect('/login');
  const workspaceId = await resolveWorkspaceId(context, params.workspaceId);
  return (
    <ExperiencePanel workspaceId={workspaceId} sessionId={params.sessionId} />
  );
}
