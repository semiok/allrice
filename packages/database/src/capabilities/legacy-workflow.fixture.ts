/** Test data only for A6-1's retained readers and provenance guards. There is
 * no production registration/binding entry point. Remove with A6-2 tables. */
import { randomUUID } from 'node:crypto';
import {
  RegisterWorkflowPackageInputSchema,
  SetWorkflowPackageBindingInputSchema,
  WorkflowPackageBindingSchema,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { capabilityChecksum } from './capability-registry.ts';
import { workflowPackageChecksum } from './workflow-package-model.ts';
import { resolveWorkflowPackageForInstance } from './workflow-packages.ts';

export async function seedLegacyWorkflowPackage(
  context: RequestContext,
  input: unknown,
) {
  const value = RegisterWorkflowPackageInputSchema.parse(input);
  const sql = getDatabase();
  const [instance] =
    await sql`select i.assignment_id,a.employee_id from allrice_employee_instances i
    join allrice_employee_assignments a on a.id=i.assignment_id where i.id=${value.instanceId}`;
  if (!instance) throw Error('legacy_fixture_instance_missing');
  const workflowId = value.workflowId ?? randomUUID(),
    id = randomUUID();
  const workflowChecksum = capabilityChecksum({
    name: value.name,
    description: value.description,
    definition: value.definition,
  });
  const checksum = workflowPackageChecksum({
    workflowChecksum,
    manifest: value.manifest,
  });
  if (!value.workflowId)
    await sql`insert into allrice_workflows(id,organization_id,workspace_id,slug,name,description,created_by)
    values(${workflowId},${context.organizationId},${value.workspaceId},${`${value.slug}-${workflowId.slice(0, 8)}`},${value.name},${value.description},${context.actor.id})`;
  await sql`insert into allrice_workflow_revisions
    (id,organization_id,workspace_id,workflow_id,revision,name,description,status,definition,checksum,created_by,published_at)
    values(${id},${context.organizationId},${value.workspaceId},${workflowId},${value.expectedRevision + 1},${value.name},${value.description},'published',${sql.json(JSON.parse(JSON.stringify(value.definition)))},${workflowChecksum},${context.actor.id},now())`;
  await sql`insert into allrice_workflow_packages
    (workflow_revision_id,organization_id,workspace_id,owner_id,assignment_id,employee_id,instance_id,scene_id,manifest,checksum,source_object_id)
    values(${id},${context.organizationId},${value.workspaceId},${context.actor.id},${instance.assignment_id},${instance.employee_id},${value.instanceId},${value.sceneId},${sql.json(value.manifest)},${checksum},${value.manifest.source?.objectId ?? null})`;
  return (
    await resolveWorkflowPackageForInstance(context, {
      workspaceId: value.workspaceId,
      instanceId: value.instanceId,
      sceneId: value.sceneId,
      workflowRevisionId: id,
    })
  ).package;
}

export async function seedLegacyWorkflowBinding(
  context: RequestContext,
  input: unknown,
) {
  const value = SetWorkflowPackageBindingInputSchema.parse(input);
  const sql = getDatabase();
  const [pkg] =
    await sql`select p.*,r.workflow_id from allrice_workflow_packages p join allrice_workflow_revisions r on r.id=p.workflow_revision_id where p.workflow_revision_id=${value.workflowRevisionId}`;
  if (!pkg) throw Error('legacy_fixture_package_missing');
  const [row] = await sql`insert into allrice_employee_workflow_bindings
    (organization_id,workspace_id,employee_id,owner_id,assignment_id,instance_id,scene_id,workflow_id,workflow_revision_id,package_checksum,enabled,bound_by,bound_at)
    values(${context.organizationId},${value.workspaceId},${pkg.employee_id},${context.actor.id},${pkg.assignment_id},${value.instanceId},${value.sceneId},${pkg.workflow_id},${value.workflowRevisionId},${pkg.checksum},${value.enabled},${context.actor.id},now())
    on conflict (organization_id,workspace_id,owner_id,instance_id,(coalesce(scene_id,'00000000-0000-0000-0000-000000000000'::uuid)),workflow_id) where instance_id is not null
    do update set workflow_revision_id=excluded.workflow_revision_id,package_checksum=excluded.package_checksum,enabled=excluded.enabled,binding_revision=allrice_employee_workflow_bindings.binding_revision+1,bound_at=now()
    returning *`;
  return WorkflowPackageBindingSchema.parse({
    id: row!.id,
    organizationId: context.organizationId,
    workspaceId: value.workspaceId,
    ownerId: context.actor.id,
    assignmentId: pkg.assignment_id,
    employeeId: pkg.employee_id,
    instanceId: value.instanceId,
    sceneId: value.sceneId,
    workflowRevisionId: value.workflowRevisionId,
    packageChecksum: pkg.checksum,
    revision: row!.binding_revision,
    enabled: value.enabled,
    boundAt: row!.bound_at.toISOString(),
  });
}
