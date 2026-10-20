/** Disposable PostgreSQL fixture for quality native tests only; no provider,
 * preview executor, shared account, or production entrypoint imports this file. */
import { randomUUID } from 'node:crypto';
import {
  PlatformEmployeeDefinitionSchema,
  PlatformEmployeeRuntimeProfileSchema,
} from '@allrice/contracts';
import { expect, vi } from 'vitest';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import { buildEmployeeRuntimePackage } from './platform-employees/runtime-package.ts';

export async function createPlatformQualityNativeFixture() {
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', `sha256:${'a'.repeat(64)}`);
  vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
  vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
  vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
  vi.stubEnv('ALLRICE_ENV', 'development');
  vi.stubEnv('ALLRICE_RELEASE_SHA', 'a'.repeat(40));
  for (const feature of [
    'RUNTIME_POLICY',
    'BRIDGE_OPERATION_LEDGER',
    'LOCAL_COMMAND',
    'CLOUD_RUNNER',
    'BROWSER_CONTROL',
    'WORKBENCH',
  ])
    vi.stubEnv(`ALLRICE_${feature}_ENABLED`, '1');
  const fixture = await createAssistantFixtureDatabase();
  const databaseSpy = vi
    .spyOn(client, 'getDatabase')
    .mockReturnValue(fixture.db);
  try {
    const { db } = fixture;
    const company = await createExperienceFixture(db);
    const principal = await ensureBootstrapPortalPrincipal(
      {
        organizationSlug: 'allrice-platform',
        organizationName: 'Platform',
        workspaceSlug: 'control-plane',
        workspaceName: 'Control plane',
        email: `native-quality-${randomUUID()}@example.test`,
        displayName: 'Isolated native quality administrator',
        role: 'member',
      },
      db,
    );
    const adminEmail = principal.user.email;
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
    const admin = (await authenticateSession(
      (await createSession(principal.user.id)).token,
    ))!;
    expect(admin.actor.id).toBe(principal.user.id);

    // Existing quality integration's SQL-only publication. The ordinary
    // ensureQualityEmployee path still materializes the current frozen package.
    const [r] = await db`select r.* from allrice_platform_employee_revisions r
      join allrice_platform_employees e on e.current_published_revision_id=r.id
      where e.employee_key='rice'`;
    expect(r).toBeDefined();
    const definition = PlatformEmployeeDefinitionSchema.parse({
      ...r!.definition,
      capabilities: {
        ...r!.definition.capabilities,
        nativeSkillIds: [],
        toolNames: [
          'workspace.project',
          'browser.workspace',
          'cloud.process.execute',
        ],
      },
    });
    const runtimePackage = buildEmployeeRuntimePackage({
      revision: r!.revision,
      definition,
      skills: [],
    });
    const profile = PlatformEmployeeRuntimeProfileSchema.parse({
      ...r!.runtime_profile,
      toolNames: definition.capabilities.toolNames,
      nativeSkillIds: [],
      nativeSkillChecksums: [],
      runtimePackage,
    });
    await db`update allrice_platform_employee_revisions set definition=${db.json(definition)},runtime_profile=${db.json(profile)},checksum=${runtimePackage.checksum},status='published',published_at=now() where id=${r!.id}`;
    await db`update allrice_platform_employees set status='published' where id=${r!.employee_id}`;
    await db`update allrice_model_connections set status='ready' where id='52000000-0000-4000-8000-000000000001'`;
    await db`update allrice_model_providers set enabled=true where provider_key='codex'`;
    return { ...fixture, company, admin, adminEmail };
  } catch (error) {
    try {
      await fixture.close();
    } finally {
      databaseSpy.mockRestore();
    }
    throw error;
  }
}
