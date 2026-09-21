// Synthetic records for isolated PostgreSQL/UI tests; never invokes a provider.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type {
  PlatformEmployeeDefinition,
  SkillBundle,
} from '@allrice/contracts';
import {
  queuePlatformEmployeeTestRun,
  completePlatformEmployeeTestRun,
  publishPlatformEmployee,
} from './employees/platform-employees.ts';
import { skillBundleChecksum, skillBytesChecksum } from './skill-bundles.ts';
import type { getDatabase } from './core/client.ts';
export async function createEmployeeAdministrationFixture(
  db: ReturnType<typeof getDatabase>,
) {
  const organizationId = randomUUID(),
    workspaceId = randomUUID(),
    ownerId = randomUUID();
  const employeeId = randomUUID(),
    skillId = randomUUID(),
    revisionId = randomUUID();
  const key = `p18-${employeeId}`,
    skillName = `p18-${skillId}`;
  await db`insert into allrice_users(id,email,display_name,password_hash) values(${ownerId},${`${ownerId}@example.test`},'Synthetic publication','not-a-login')`;
  await db`insert into allrice_organizations(id,slug,name) values(${organizationId},${key},'Synthetic publication')`;
  await db`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspaceId},${organizationId},'default','Synthetic publication')`;
  await db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${organizationId},${workspaceId},${ownerId},'admin')`;
  const definition: PlatformEmployeeDefinition = {
    schemaVersion: 1,
    key,
    name: 'Synthetic publication',
    description: 'Only synthetic package authority checks',
    appearance: { avatarType: 'initials', avatarValue: 'P' },
    identity: {
      role: 'Reviewer',
      mission: 'Test',
      workStyle: 'Controlled',
      behaviorRules: ['No implicit authority'],
      safetyBoundaries: ['Synthetic only'],
      expressionStyle: 'structured',
      outputLanguage: 'zh-CN',
    },
    systemPrompt: 'Synthetic platform policy.',
    modelPolicy: {
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'xhigh',
      timeoutMs: 300000,
      fallbackModels: [],
      credentialReference: 'deployment:codex-default',
      baseUrl: null,
    },
    capabilities: {
      nativeSkillIds: [skillId],
      workflowRevisionIds: [],
      knowledgeRevisionIds: [],
      toolNames: ['workspace.skill.read'],
      connectorRefs: [],
    },
    securityPolicy: {
      dataScopes: ['workspace'],
      approvalPolicy: 'confirm_side_effects',
      bridgeAccess: 'none',
      connectorIdentityModes: [],
      deniedCapabilities: ['secret:use'],
    },
  };
  const content = '# Synthetic reviewed Skill\n';
  function bundle(version: string, text: string) {
    const bytes = Buffer.from(text);
    const payload: Omit<SkillBundle, 'checksum'> = {
      schemaVersion: 1,
      version,
      contentChecksum: skillBytesChecksum(content),
      sourceRef: `https://example.test/skill?content-sha256=${skillBytesChecksum(content).slice(7)}`,
      license: 'Apache-2.0',
      reviewedBy: 'Synthetic reviewer',
      resources: [
        {
          path: 'references/rules.txt',
          mediaType: 'text/plain',
          byteLength: bytes.length,
          checksum: skillBytesChecksum(bytes),
          contentBase64: bytes.toString('base64'),
        },
      ],
      dependencies: [{ kind: 'tool', name: 'workspace.skill.read' }],
    };
    return { ...payload, checksum: skillBundleChecksum(payload) };
  }
  const a = bundle('1.0.0', 'Reviewed A\n'),
    b = bundle('1.1.0', 'Reviewed B\n');
  async function catalog(value: SkillBundle) {
    await db`insert into allrice_platform_dsh_skills(id,name,description,content,checksum,required_tool_refs,source,source_ref,version,license,review_status,reviewed_by_label,reviewed_at,bundle)
      values(${skillId},${skillName},'Synthetic resource',${content},${skillBytesChecksum(content)},${db.json(['workspace.skill.read'])},'allrice',${value.sourceRef},${value.version},${value.license},'reviewed',${value.reviewedBy},'2026-09-08T00:00:00Z',${db.json(value)})
      on conflict(id) do update set version=excluded.version,bundle=excluded.bundle`;
    await db`insert into allrice_platform_skill_bundle_versions(skill_id,version,checksum,bundle)
      values(${skillId},${value.version},${value.checksum},${db.json(value)}) on conflict do nothing`;
  }
  await catalog(a);
  await db`insert into allrice_platform_employees(id,employee_key,name,description,status) values(${employeeId},${key},'Synthetic publication','Synthetic only','draft')`;
  await db`insert into allrice_platform_employee_revisions(id,employee_id,revision,status,definition,checksum)
    values(${revisionId},${employeeId},1,'draft',${db.json(definition)},${skillBytesChecksum(JSON.stringify(definition))})`;
  await db`update allrice_platform_employees set current_draft_revision_id=${revisionId} where id=${employeeId}`;
  await db`update allrice_provider_status set status='connected',checked_at=clock_timestamp() where provider='codex'`;
  async function preview() {
    // Queue through the real public API to capture its exact immutable inputs.
    // Only model completion is synthetic; this test never invokes a provider.
    const result = await queuePlatformEmployeeTestRun(employeeId, {
      workspaceId,
      prompt: 'Review the synthetic resource.',
    });
    expect(result.queued).toBe(true);
    const id = result.testRun!.id;
    await db`update allrice_platform_employee_test_runs set status='running',started_at=clock_timestamp(),timeout_at=clock_timestamp()+interval '5 minutes' where id=${id}`;
    const done = await completePlatformEmployeeTestRun(id, {
      answer: 'Synthetic reviewed.',
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      threadId: null,
      usage: null,
      events: [],
      error: null,
    });
    expect(done.status).toBe('succeeded');
    const [row] =
      await db`select frozen_package_checksum from allrice_platform_employee_test_runs where id=${id}`;
    return {
      id,
      checksum: row!.frozen_package_checksum as string,
      revisionId: result.testRun!.revisionId,
    };
  }
  const publish = () =>
    publishPlatformEmployee(employeeId, { workspaceIds: [workspaceId] });
  const revision = async (id: string = revisionId) =>
    (
      await db`select * from allrice_platform_employee_revisions where id=${id}`
    )[0]!;
  const assigned = async () =>
    (
      await db`select count(*)::integer as count from allrice_platform_employee_tenant_assignments where employee_id=${employeeId}`
    )[0]!.count;
  return {
    organizationId,
    workspaceId,
    ownerId,
    skillId,
    employeeId,
    revisionId,
    definition,
    a,
    b,
    catalog,
    preview,
    publish,
    revision,
    assigned,
  };
}
