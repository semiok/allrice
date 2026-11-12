import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EmployeeDefinitionSchema } from '@allrice/contracts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from './employee-config.ts';
import {
  employeePersonaAdmission,
  readEmployeePersonaVersion,
  readEmployeeTenantPersonaVersion,
} from './employee-instances.ts';
import { employeePersonaManifestMaterial } from '../platform-employees/runtime-package.ts';
import * as personaRuntime from '../platform-employees/runtime-package.ts';
import { validateEmployeeExecutionSource } from '../conversation/current-execution-binding.ts';

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
      { ...identity, forRunInput: true },
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

  it('keeps historical null-source reads unchanged but refuses new input without parsing its composite prompt', async () => {
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
    await expect(
      readEmployeeTenantPersonaVersion(
        { ...scope(), forRunInput: true },
        reader(legacy, employeeManifestChecksum(legacy)),
      ),
    ).rejects.toMatchObject({
      message: 'employee_persona_source_unavailable',
      cause: 'legacy_null_package_persona_source_missing',
    });
    expect(legacy).toEqual(original);
  });

  it('rejects raw v1 absence only for a new default basis, preserving read-only and non-basis absence', async () => {
    const current = source();
    const legacy = {
      schemaVersion: 1,
      key: current.key,
      name: current.name,
      description: current.description,
      systemPrompt: 'Original composite text is not independent policy',
      provider: current.provider,
      capabilities: current.capabilities,
      skillVersionIds: current.skillVersionIds,
      partnerProfile: current.partnerProfile,
    };
    const sql = reader(legacy, 'original-v1-checksum');
    for (const input of [
      { ...scope(), role: 'basis' as const },
      { ...scope(), role: 'engine' as const, forRunInput: true },
    ])
      expect(
        await readEmployeeTenantPersonaVersion(input, sql),
      ).toBeUndefined();
    await expect(
      readEmployeeTenantPersonaVersion(
        { ...scope(), role: 'basis', forRunInput: true },
        sql,
      ),
    ).rejects.toMatchObject({
      message: 'employee_persona_source_unavailable',
      cause: 'legacy_v1_basis_persona_source_missing',
    });
  });

  it.each([null, {}, { schemaVersion: 2 }])(
    'does not turn unrelated raw absence %j into an approved legacy source gap',
    async (raw) => {
      expect(
        await readEmployeeTenantPersonaVersion(
          { ...scope(), role: 'basis', forRunInput: true },
          reader(raw, 'original-checksum'),
        ),
      ).toBeUndefined();
    },
  );

  it.each([1, 2])(
    'reports exact old-package %s policy absence only when preparing new input',
    async (schemaVersion) => {
      const { personaSource, ...legacy } = source();
      void personaSource;
      // Presence classification only; real signed old packages and publication
      // relationships are covered through the SQL producer integration test.
      const manifest = { ...legacy, runtimePackage: { schemaVersion } };
      const original = structuredClone(manifest);
      const sql = reader(manifest, 'unchanged-original-checksum');
      expect(
        await readEmployeeTenantPersonaVersion(scope(), sql),
      ).toBeUndefined();
      await expect(
        readEmployeeTenantPersonaVersion(
          { ...scope(), forRunInput: true },
          sql,
        ),
      ).rejects.toMatchObject({
        message: 'employee_persona_source_unavailable',
        cause: 'legacy_runtime_package_platform_policy_missing',
      });
      expect(manifest).toEqual(original);
    },
  );

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

describe('PERSONA source preparation and raw OCC', () => {
  function admissionSource() {
    const identity = scope();
    const manifest = source();
    let current = {
      manifest,
      config_checksum: employeeManifestChecksum(manifest),
      mapping_id: null as string | null,
    };
    let active = false;
    const tx = vi.fn(async () => [structuredClone(current)]);
    const database = Object.assign(
      vi.fn(async () => [structuredClone(current)]),
      {
        begin: vi.fn(
          async (operation: (sql: typeof tx) => Promise<unknown>) => {
            active = true;
            try {
              return await operation(tx);
            } finally {
              active = false;
            }
          },
        ),
      },
    ) as unknown as Parameters<typeof employeePersonaAdmission>[0];
    const target = { ...identity, versionIds: [identity.versionId] };
    return {
      identity,
      manifest,
      target,
      database,
      active: () => active,
      replace: (next: typeof current) => {
        current = next;
      },
    };
  }

  it('parses the complete source before begin and only compares current raw facts in admission', async () => {
    const f = admissionSource();
    const parse = EmployeeDefinitionSchema.parse;
    const phases: boolean[] = [];
    const spy = vi
      .spyOn(EmployeeDefinitionSchema, 'parse')
      .mockImplementation((...args) => {
        phases.push(f.active());
        return Reflect.apply(parse, EmployeeDefinitionSchema, args);
      });
    try {
      const value = await employeePersonaAdmission(
        f.database,
        f.target,
        async (tx) => {
          return readEmployeePersonaVersion(
            { ...f.identity, role: 'engine', forRunInput: true },
            tx,
          );
        },
      );
      expect(value?.source).toMatchObject({
        kind: 'tenant_version',
        employeeVersionId: f.identity.versionId,
      });
      expect(phases.length).toBeGreaterThan(0);
      expect(phases.every((active) => !active)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a full raw manifest change even when its stored checksum is unchanged', async () => {
    const f = admissionSource();
    await expect(
      employeePersonaAdmission(f.database, f.target, async (tx) => {
        f.replace({
          manifest: {
            ...f.manifest,
            description: 'changed without updating the stored checksum',
          },
          config_checksum: employeeManifestChecksum(f.manifest),
          mapping_id: null,
        });
        await readEmployeePersonaVersion({ ...f.identity, role: 'engine' }, tx);
      }),
    ).rejects.toMatchObject({ code: 'instance_conflict' });
  });

  it('rechecks after the last outer write and does not keep a stale prepared proof', async () => {
    const f = admissionSource();
    await expect(
      employeePersonaAdmission(f.database, f.target, async (tx) => {
        await readEmployeePersonaVersion({ ...f.identity, role: 'engine' }, tx);
        f.replace({
          manifest: {
            ...f.manifest,
            description: 'changed after inner admission',
          },
          config_checksum: employeeManifestChecksum(f.manifest),
          mapping_id: null,
        });
      }),
    ).rejects.toMatchObject({ code: 'instance_conflict' });
  });

  it('defers invalid source errors until after the original authority gate', async () => {
    const f = admissionSource();
    f.replace({
      manifest: f.manifest,
      config_checksum: `sha256:${'0'.repeat(64)}`,
      mapping_id: null,
    });
    const denied = Error('current authority denied');
    await expect(
      employeePersonaAdmission(f.database, f.target, async () => {
        throw denied;
      }),
    ).rejects.toBe(denied);
    await expect(
      employeePersonaAdmission(f.database, f.target, async (tx) => {
        await readEmployeePersonaVersion({ ...f.identity, role: 'engine' }, tx);
      }),
    ).rejects.toThrow('CURRENT_EXECUTION_SOURCE_CHECKSUM_MISMATCH');
  });

  it('classifies the current exact legacy null gap inside admission rather than returning a stale preparation error', async () => {
    const f = admissionSource();
    await expect(
      employeePersonaAdmission(f.database, f.target, async (tx) => {
        const { personaSource, ...legacy } = f.manifest;
        void personaSource;
        f.replace({
          manifest: legacy as typeof f.manifest,
          config_checksum: employeeManifestChecksum(legacy),
          mapping_id: null,
        });
        await readEmployeePersonaVersion(
          { ...f.identity, role: 'engine', forRunInput: true },
          tx,
        );
      }),
    ).rejects.toMatchObject({
      message: 'employee_persona_source_unavailable',
      cause: 'legacy_null_package_persona_source_missing',
    });
  });

  it('rejects an unprepared source and preserves the historical complete verifier outside admission', async () => {
    const f = admissionSource();
    await expect(
      employeePersonaAdmission(
        f.database,
        { ...f.target, versionIds: [] },
        async (tx) => {
          await readEmployeePersonaVersion(
            { ...f.identity, role: 'engine' },
            tx,
          );
        },
      ),
    ).rejects.toMatchObject({ code: 'instance_conflict' });
    f.replace({
      manifest: f.manifest,
      config_checksum: `sha256:${'0'.repeat(64)}`,
      mapping_id: null,
    });
    await expect(
      readEmployeePersonaVersion({ ...f.identity, role: 'engine' }, f.database),
    ).rejects.toThrow('CURRENT_EXECUTION_SOURCE_CHECKSUM_MISMATCH');
  });

  it('reuses the prepared current-binding projection without moving baseline checksum validation', async () => {
    const f = admissionSource();
    const input = {
      employeeVersionId: f.identity.versionId,
      configChecksum: employeeManifestChecksum(f.manifest),
      manifest: structuredClone(f.manifest),
    };
    const material = personaRuntime.employeePersonaManifestMaterial;
    const phases: boolean[] = [];
    const spy = vi
      .spyOn(personaRuntime, 'employeePersonaManifestMaterial')
      .mockImplementation((...args) => {
        phases.push(f.active());
        return Reflect.apply(material, personaRuntime, args);
      });
    try {
      const actual = await employeePersonaAdmission(
        f.database,
        f.target,
        async (tx) => {
          expect(() =>
            validateEmployeeExecutionSource(
              { ...input, configChecksum: `sha256:${'0'.repeat(64)}` },
              tx,
            ),
          ).toThrow('CURRENT_EXECUTION_SOURCE_CHECKSUM_MISMATCH');
          return validateEmployeeExecutionSource(input, tx);
        },
      );
      expect(actual.source.employeeVersionId).toBe(f.identity.versionId);
      expect(phases.length).toBeGreaterThan(0);
      expect(phases.every((active) => !active)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['miss', 'stale'] as const)(
    'rejects a current-binding projection %s without a locked fallback',
    async (kind) => {
      const f = admissionSource();
      const { runtimePackage, ...rawWithoutDefault } = f.manifest;
      void runtimePackage;
      const manifest =
        kind === 'stale' ? rawWithoutDefault : structuredClone(f.manifest);
      const input = {
        employeeVersionId: f.identity.versionId,
        configChecksum: employeeManifestChecksum(f.manifest),
        manifest,
      };
      // Missing raw null differs from the original bytes, but schema defaults
      // produce the same valid definition/checksum. A fallback would accept it.
      expect(EmployeeDefinitionSchema.parse(manifest)).toEqual(f.manifest);
      expect(
        validateEmployeeExecutionSource(input).source.employeeVersionId,
      ).toBe(f.identity.versionId);
      await expect(
        employeePersonaAdmission(
          f.database,
          kind === 'miss' ? { ...f.target, versionIds: [] } : f.target,
          async (tx) => validateEmployeeExecutionSource(input, tx),
        ),
      ).rejects.toMatchObject({ code: 'instance_conflict' });
    },
  );

  it('keeps projection-only callers free of extra engine eligibility and still checks final complete raw facts', async () => {
    const f = admissionSource();
    const input = {
      employeeVersionId: f.identity.versionId,
      configChecksum: employeeManifestChecksum(f.manifest),
      manifest: f.manifest,
    };
    const row = {
      manifest: f.manifest,
      config_checksum: input.configChecksum,
      mapping_id: randomUUID(),
    };
    // Such a row fails the PERSONA engine/publication reader. That eligibility
    // was never a condition of the existing current-binding projection check.
    f.replace(row);
    expect(
      await employeePersonaAdmission(f.database, f.target, async (tx) =>
        validateEmployeeExecutionSource(input, tx),
      ),
    ).toEqual(validateEmployeeExecutionSource(input));
    await expect(
      employeePersonaAdmission(f.database, f.target, async (tx) => {
        validateEmployeeExecutionSource(input, tx);
        f.replace({ ...row, mapping_id: randomUUID() });
      }),
    ).rejects.toMatchObject({ code: 'instance_conflict' });
  });

  it('defers cached projection errors behind authority/checksum and fully validates unregistered or expired transaction objects', async () => {
    const f = admissionSource();
    const manifest = {
      ...f.manifest,
      systemPrompt: `${f.manifest.systemPrompt}\nsubstituted policy`,
    };
    const input = {
      employeeVersionId: f.identity.versionId,
      configChecksum: employeeManifestChecksum(manifest),
      manifest,
    };
    f.replace({
      manifest,
      config_checksum: input.configChecksum,
      mapping_id: null,
    });
    const denied = Error('current authority denied');
    await expect(
      employeePersonaAdmission(f.database, f.target, async () => {
        throw denied;
      }),
    ).rejects.toBe(denied);
    let expired: Parameters<typeof validateEmployeeExecutionSource>[1];
    await expect(
      employeePersonaAdmission(f.database, f.target, async (tx) => {
        expired = tx;
        expect(() =>
          validateEmployeeExecutionSource(
            { ...input, configChecksum: `sha256:${'0'.repeat(64)}` },
            tx,
          ),
        ).toThrow('CURRENT_EXECUTION_SOURCE_CHECKSUM_MISMATCH');
        return validateEmployeeExecutionSource(input, tx);
      }),
    ).rejects.toThrow('employee_persona_source_projection_mismatch');
    expect(expired).toBeDefined();
    const forged = vi.fn() as unknown as NonNullable<typeof expired>;
    for (const tx of [undefined, forged, expired])
      expect(() => validateEmployeeExecutionSource(input, tx)).toThrow(
        'employee_persona_source_projection_mismatch',
      );
  });
});
