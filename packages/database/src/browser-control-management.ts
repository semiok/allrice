import { BrowserProfileSchema, type RequestContext } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  browserControlEnabled,
  browserIdentity,
} from './browser-control-authority.ts';
/** Read-only administrator projection. Never provisions targets or enables execution. */
export async function listBrowserControlManagement(
  ctx: RequestContext,
  db = getDatabase(),
) {
  return db.begin(async (tx) => {
    await browserIdentity(tx, ctx, true);
    const targets = await tx<{ id: string; label: string; state: string }[]>`
      select id,label,state from allrice_execution_targets where organization_id=${ctx.organizationId}
      and workspace_id=${ctx.workspaceId} and kind='cloud_sandbox' and capabilities ? 'browser.navigate' order by label,id`;
    const members = await tx<{ id: string; name: string }[]>`
      select distinct u.id,u.display_name as name from allrice_users u join allrice_memberships m on m.user_id=u.id
      where m.organization_id=${ctx.organizationId} and (m.workspace_id is null or m.workspace_id=${ctx.workspaceId})
      and m.active and u.status='active' order by name,u.id`;
    const rows = await tx<
      {
        id: string;
        target_id: string;
        owner_id: string;
        profile: unknown;
        enabled: boolean;
        revoked_at: Date | null;
      }[]
    >`
      select id,target_id,owner_id,profile,enabled,revoked_at from allrice_browser_control_grants
      where organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} and transport='cloud' order by created_at desc limit 100`;
    return {
      enabled: browserControlEnabled(),
      humanCredentialsConfigured: /^[a-f0-9]{64}$/i.test(
        process.env.ALLRICE_BROWSER_CONTROL_KEY ?? '',
      ),
      targets,
      members,
      grants: rows.map((r) => ({
        id: r.id,
        targetId: r.target_id,
        ownerId: r.owner_id,
        profile: BrowserProfileSchema.parse(r.profile),
        enabled: r.enabled,
        revokedAt: r.revoked_at?.toISOString() ?? null,
      })),
    };
  });
}
export type BrowserControlManagement = Awaited<
  ReturnType<typeof listBrowserControlManagement>
>;
