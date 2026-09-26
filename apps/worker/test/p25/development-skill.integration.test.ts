import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assembleEmployeeCapabilities } from '@allrice/contracts';
import * as client from '../../../../packages/database/src/core/client.ts';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../../../../packages/database/src/employee-administration.fixture.ts';
import { loadPlatformContentCatalog } from '../../../../packages/database/src/platform-content/catalog.ts';
import { synchronizePlatformContent } from '../../../../packages/database/src/platform-content/sync.ts';
import {
  savePlatformEmployeeDraft,
  rollbackPlatformEmployee,
} from '../../../../packages/database/src/employees/platform-employees.ts';
import {
  frozenPackageSkills,
  skillBundleChecksum,
  skillBytesChecksum,
} from '../../../../packages/database/src/skill-bundles.ts';
import { developmentAssignmentMessage } from '../../src/development/assignment-instructions.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET155 development SOP publication and rollback', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    vi.stubEnv('ALLRICE_ENV', 'development');
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });
  it('assembles the real Skill, freezes all roles, publishes a resource-only upgrade and restores the old package', async () => {
    const catalog = await loadPlatformContentCatalog();
    const skill = catalog.skills.find(
      (s) => s.name === 'development-cooperation',
    )!;
    await synchronizePlatformContent(catalog);
    const f = await createEmployeeAdministrationFixture(fixture.db);
    const definition = assembleEmployeeCapabilities(
      {
        ...f.definition,
        capabilities: {
          ...f.definition.capabilities,
          nativeSkillIds: [skill.id],
          explicitToolNames: [],
          toolNames: [],
        },
        securityPolicy: {
          ...f.definition.securityPolicy,
          bridgeAccess: 'read_write',
        },
      },
      catalog.skills,
    );
    expect(definition.capabilities.toolNames).toEqual(
      expect.arrayContaining([
        'assistant.development',
        'assistant.delegate',
        'assistant.report',
        'local.process.execute',
        'workspace.skill.read',
      ]),
    );
    await savePlatformEmployeeDraft(f.employeeId, { definition });
    const first = await f.preview();
    expect((await f.publish()).valid).toBe(true);
    const a = await f.revision(first.revisionId);
    const frozenA = frozenPackageSkills(a.runtime_profile.runtimePackage);
    const assignment = {
      role: 'test' as const,
      expectedHead: {
        artifactId: f.employeeId,
        digest: `sha256:${'a'.repeat(64)}`,
      },
    };
    const oldMessage = developmentAssignmentMessage(
      assignment,
      'verifier-id',
      frozenA,
    );
    expect(oldMessage).toContain('依据成员当前工作方式决定自动执行或等待确认');
    expect(oldMessage).not.toContain('"assignmentId":');
    expect(
      developmentAssignmentMessage(
        { ...assignment, role: 'edit', paths: ['sum.mjs'] },
        'editor-id',
        frozenA,
      ),
    ).toContain('"assignmentId":"editor-id"');
    expect(
      developmentAssignmentMessage(
        { ...assignment, role: 'review' },
        'reviewer-id',
        frozenA,
      ),
    ).toContain('独立');
    const [queued] =
      await fixture.db`select frozen_runtime_profile from allrice_platform_employee_test_runs where id=${first.id}`;

    // A pure resource release: no Skill body/tool/schema/Worker change.
    const bundle = skill.bundle!;
    const resource = bundle.resources.find(
      (r) => r.path === 'references/test.md',
    )!;
    const bytes = Buffer.from(
      Buffer.from(resource.contentBase64, 'base64').toString('utf8') +
        '\nMET155 resource-only update.\n',
    );
    Object.assign(resource, {
      contentBase64: bytes.toString('base64'),
      byteLength: bytes.length,
      checksum: skillBytesChecksum(bytes),
    });
    bundle.version = skill.version = '99.0.0';
    const { checksum, ...payload } = bundle;
    bundle.checksum = skillBundleChecksum(payload);
    expect(bundle.checksum).not.toBe(checksum);
    await synchronizePlatformContent(catalog);
    expect(
      developmentAssignmentMessage(assignment, 'verifier-id', frozenA),
    ).toBe(oldMessage);
    await savePlatformEmployeeDraft(f.employeeId, { definition });
    const second = await f.preview();
    expect((await f.publish()).valid).toBe(true);
    const b = await f.revision(second.revisionId);
    const frozenB = frozenPackageSkills(b.runtime_profile.runtimePackage);
    expect(frozenA[0]!.checksum).toBe(frozenB[0]!.checksum);
    expect(
      developmentAssignmentMessage(assignment, 'verifier-id', frozenB),
    ).toContain('MET155 resource-only update.');
    expect(await f.revision(first.revisionId)).toEqual(a);
    expect(
      (
        await fixture.db`select frozen_runtime_profile from allrice_platform_employee_test_runs where id=${first.id}`
      )[0],
    ).toEqual(queued);
    await rollbackPlatformEmployee(f.employeeId, {
      revisionId: first.revisionId,
      reason: 'MET155 resource rollback regression',
    });
    const [binding] =
      await fixture.db`select revision_id from allrice_platform_employee_tenant_assignments where employee_id=${f.employeeId} and workspace_id=${f.workspaceId}`;
    expect(binding!.revision_id).toBe(first.revisionId);
    expect(
      developmentAssignmentMessage(
        assignment,
        'verifier-id',
        frozenPackageSkills(
          (await f.revision(first.revisionId)).runtime_profile.runtimePackage,
        ),
      ),
    ).toBe(oldMessage);

    const corrupt = structuredClone(frozenB);
    corrupt[0]!.bundle!.resources[0]!.contentBase64 =
      Buffer.from('tampered').toString('base64');
    expect(() =>
      developmentAssignmentMessage(assignment, 'verifier-id', corrupt),
    ).toThrow('skill_bundle_checksum_mismatch');
  }, 30000);
});
