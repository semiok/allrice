import type { EmployeePromptSnapshotSchema } from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';

type OrganizationContext = ReturnType<
  typeof EmployeePromptSnapshotSchema.parse
>['organizationContext'];

/** Facts for a new Run. Old persisted snapshots legitimately omit this field. */
export async function readEmployeeOrganizationContext(
  organizationId: string,
  userId: string,
): Promise<OrganizationContext> {
  const db = getDatabase();
  const [person] = await db`
    select o.name as company_name,o.business_context,coalesce(p.display_name,u.display_name) as display_name,
      coalesce(p.job_title,'') as job_title,coalesce(p.responsibilities,'') as responsibilities
    from allrice_organizations o join allrice_users u on u.id=${userId}
    left join allrice_organization_people p on p.organization_id=o.id and p.user_id=u.id
    where o.id=${organizationId} and o.archived_at is null`;
  if (!person) throw Error('employee_organization_context_not_found');
  return {
    organizationId,
    userId,
    companyName: person.company_name,
    businessContext: person.business_context,
    displayName: person.display_name,
    jobTitle: person.job_title,
    responsibilities: person.responsibilities,
  };
}
