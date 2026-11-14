import type { RequestContext } from '@allrice/contracts';
import { employeeChatUuid } from './employee-chat-authority.ts';
import type { ContentTx } from './employee-content-model.ts';

/** Resolve the private content set after the caller has checked instance access. */
export async function resolvePersonalEmployeeContentTarget(
  context: Pick<RequestContext, 'actor' | 'organizationId' | 'workspaceId'>,
  instanceId: string,
  tx: ContentTx,
) {
  const [row] = await tx<
    { id: string }[]
  >`select id from allrice_employee_content_sets
    where organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
      and instance_id=${instanceId} and scope='personal' and owner_id=${context.actor.id}`;
  return {
    setId: row?.id ?? employeeChatUuid('employee-method', instanceId),
    target: { kind: 'instance' as const, instanceId },
    ownership: {
      scope: 'personal' as const,
      organizationId: context.organizationId,
      ownerId: context.actor.id,
    },
  };
}
