import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EmployeeDefinitionSchema } from '@allrice/contracts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from './employee-config.ts';
import { readEmployeeTenantPersonaVersion } from './employee-instances.ts';
import { employeePersonaManifestMaterial } from '../platform-employees/runtime-package.ts';

function source() {
  return EmployeeDefinitionSchema.parse(
    employeeManifest({
      key: 'tenant-source',
      name: 'Unique tenant identity',
      description: 'Independent tenant source fixture',
      partnerProfile: {
        role: 'Unique role',
        mission: 'Unique mission',
        communicationStyle: 'exploratory',
        outputLanguage: 'en-US',
        proactivePolicy: 'ask',
        approvalPolicy: 'confirm_external',
      },
    }),
  );
}
const scope = () => ({
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  employeeId: randomUUID(),
  versionId: randomUUID(),
});
function reader(
  manifest: unknown,
  checksum: string,
  mapping: string | null = null,
) {
  return vi
    .fn()
    .mockResolvedValue([
      { manifest, config_checksum: checksum, mapping_id: mapping },
    ]) as unknown as Parameters<typeof readEmployeeTenantPersonaVersion>[1];
}

describe('explicit definition-only PERSONA materials', () => {
  it('keeps identity in structure and preserves existing proactive/approval policy in the clean system', () => {
    const manifest = source();
    const material = employeePersonaManifestMaterial(manifest)!;
    expect(manifest.runtimePackage).toBeNull();
    expect(material.foundation.identity).toMatchObject({
      role: 'Unique role',
      mission: 'Unique mission',
      expressionStyle: 'exploratory',
      outputLanguage: 'en-US',
    });
    expect(material.platformPolicy).toContain(
      'Ask before proposing any proactive follow-up',
    );
    expect(material.platformPolicy).toContain(
      'ask for explicit confirmation before external communication or irreversible changes',
    );
    for (const identity of [
      'Unique tenant identity',
      'Unique role',
      'Unique mission',
    ]) {
      expect(material.platformPolicy).not.toContain(identity);
      expect(manifest.systemPrompt).not.toContain(identity);
    }
    expect(manifest.securityPolicy.approvalPolicy).toBe('confirm_external');
    expect(manifest.capabilityBindings.toolNames).toContain(
      'workspace.file.read',
    );
    expect(manifest.systemPrompt).toContain(material.platformPolicy);
    expect(manifest.systemPrompt).toContain(
      manifest.identity.safetyBoundaries[0],
    );
  });

  it('reads the actual immutable tenant identity without inventing template/package evidence', async () => {
    const manifest = source(),
      identity = scope();
    const checksum = employeeManifestChecksum(manifest);
    const before = structuredClone(manifest);
    const actual = await readEmployeeTenantPersonaVersion(
      identity,
      reader(manifest, checksum),
    );
    expect(actual?.source).toMatchObject({
      kind: 'tenant_version',
      employeeVersionId: identity.versionId,
      configChecksum: checksum,
    });
    for (const field of [
      'templateId',
      'templateRevisionId',
      'templateRevision',
      'templateChecksum',
      'packageChecksum',
    ])
      expect(actual?.source).not.toHaveProperty(field);
    expect(actual?.material).toEqual(manifest.personaSource);
    expect(manifest).toEqual(before);
  });

  it('keeps historical raw absence unchanged and never parses its composite prompt', async () => {
    const { personaSource, ...legacy } = source();
    void personaSource;
    legacy.systemPrompt =
      'Original composite policy and identity; # IDENTITY.md quoted.';
    const original = structuredClone(legacy);
    expect(EmployeeDefinitionSchema.parse(legacy)).not.toHaveProperty(
      'personaSource',
    );
    expect(
      await readEmployeeTenantPersonaVersion(
        scope(),
        reader(legacy, employeeManifestChecksum(legacy)),
      ),
    ).toBeUndefined();
    expect(legacy).toEqual(original);
  });

  it('rejects nonempty broken materials and checksum drift rather than treating them as absence', async () => {
    const manifest = source();
    await expect(
      readEmployeeTenantPersonaVersion(
        scope(),
        reader(
          { ...manifest, personaSource: null },
          employeeManifestChecksum(manifest),
        ),
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      readEmployeeTenantPersonaVersion(
        scope(),
        reader(manifest, `sha256:${'0'.repeat(64)}`),
      ),
    ).rejects.toThrow('CURRENT_EXECUTION_SOURCE_CHECKSUM_MISMATCH');
    manifest.personaSource!.platformPolicy += ' changed';
    await expect(
      readEmployeeTenantPersonaVersion(
        scope(),
        reader(manifest, employeeManifestChecksum(manifest)),
      ),
    ).rejects.toThrow('employee_persona_source_projection_mismatch');
  });

  it('does not turn a real platform mapping or a changed expected source into tenant provenance', async () => {
    const manifest = source(),
      identity = scope();
    await expect(
      readEmployeeTenantPersonaVersion(
        identity,
        reader(manifest, employeeManifestChecksum(manifest), randomUUID()),
      ),
    ).rejects.toThrow('employee_persona_source_mapping_invalid');
    await expect(
      readEmployeeTenantPersonaVersion(
        {
          ...identity,
          expectedSource: {
            kind: 'tenant_version',
            employeeVersionId: randomUUID(),
          },
        },
        reader(manifest, employeeManifestChecksum(manifest)),
      ),
    ).rejects.toThrow('employee_persona_source_mapping_invalid');
  });
});
