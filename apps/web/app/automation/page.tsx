import { FolderRules } from './folder-rules';
export const dynamic = 'force-dynamic';
export default async function AutomationPage({
  searchParams,
}: {
  searchParams: Promise<{ workspaceId?: string }>;
}) {
  const { workspaceId } = await searchParams;
  return <FolderRules workspaceId={workspaceId} />;
}
