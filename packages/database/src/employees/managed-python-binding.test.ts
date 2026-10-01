import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EmployeeCapabilityBindingsSchema,
  EmployeeDefinitionSchema,
  FrozenEmployeeCapabilityBindingsSchema,
  FrozenManagedPythonBindingSchema,
  PlatformEmployeeDefinitionSchema,
} from '@allrice/contracts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from './employee-config.ts';
import {
  freezeManagedOfficeBinding,
  freezeManagedPythonBinding,
} from './managed-python-binding.ts';

function fixture() {
  const manifest = EmployeeDefinitionSchema.parse(
    employeeManifest({
      key: 'office',
      name: 'Office',
      description: 'Native Office',
      toolNames: ['workspace.export.create'],
    }),
  );
  const definition = PlatformEmployeeDefinitionSchema.parse({
    schemaVersion: 1,
    key: 'office',
    name: 'Office',
    description: 'Native Office',
    appearance: manifest.appearance,
    identity: {
      ...manifest.identity,
      expressionStyle: 'structured',
      outputLanguage: 'zh-CN',
    },
    systemPrompt: manifest.systemPrompt,
    modelPolicy: {
      provider: 'openai-codex',
      model: 'test-model',
      reasoningEffort: 'high',
      timeoutMs: 300_000,
      fallbackModels: [],
      credentialReference: 'deployment:codex-default',
      baseUrl: null,
    },
    capabilities: {
      nativeSkillIds: [],
      workflowRevisionIds: [],
      knowledgeRevisionIds: [],
      toolNames: ['workspace.export.create'],
      connectorRefs: [],
    },
    securityPolicy: { ...manifest.securityPolicy, bridgeAccess: 'read_write' },
  });
  return {
    manifest,
    grantedCapabilities: ['storage:write' as const],
    publication: {
      revisionId: randomUUID(),
      checksum: `sha256:${'a'.repeat(64)}`,
      definition,
    },
  };
}

describe('publication-derived managed Office delegation', () => {
  it('freezes only Office and an immutable publication proof without modifying the manifest', () => {
    const input = fixture(),
      original = JSON.stringify(input.manifest),
      checksum = employeeManifestChecksum(input.manifest);
    expect(freezeManagedOfficeBinding(input)).toEqual({
      contractVersion: 1,
      profileVersion: 1,
      purposes: ['office'],
      publication: {
        revisionId: input.publication.revisionId,
        checksum: input.publication.checksum,
      },
    });
    expect(JSON.stringify(input.manifest)).toBe(original);
    expect(employeeManifestChecksum(input.manifest)).toBe(checksum);
  });
  it.each(['none', 'read_only'] as const)(
    'requires published Bridge write access, not %s',
    (bridgeAccess) => {
      const input = fixture();
      input.publication.definition.securityPolicy.bridgeAccess = bridgeAccess;
      expect(freezeManagedOfficeBinding(input)).toBeUndefined();
    },
  );
  it('does not infer publication provenance or storage permission', () => {
    const input = fixture();
    expect(
      freezeManagedOfficeBinding({ ...input, publication: null }),
    ).toBeUndefined();
    expect(
      freezeManagedOfficeBinding({ ...input, grantedCapabilities: [] }),
    ).toBeUndefined();
    expect(
      freezeManagedOfficeBinding({
        ...input,
        publication: { ...input.publication, checksum: 'invalid' },
      }),
    ).toBeUndefined();
  });
  it.each(['published', 'frozen'] as const)(
    'respects %s tool removal and explicit denial',
    (source) => {
      const input = fixture();
      if (source === 'published')
        input.publication.definition.capabilities.toolNames = [];
      else input.manifest.capabilityBindings.toolNames = [];
      expect(freezeManagedOfficeBinding(input)).toBeUndefined();
      const denied = fixture();
      if (source === 'published')
        denied.publication.definition.securityPolicy.deniedCapabilities.push(
          'storage:write',
        );
      else
        denied.manifest.securityPolicy.deniedCapabilities.push('storage:write');
      expect(freezeManagedOfficeBinding(denied)).toBeUndefined();
    },
  );
  it('cannot acquire Office authority by registering only the future Python tool', () => {
    const input = fixture();
    input.publication.definition.capabilities.toolNames = ['python.execute'];
    expect(freezeManagedOfficeBinding(input)).toBeUndefined();
  });
  it('freezes chart authority independently from Office and legacy cloud tools', () => {
    const input = fixture();
    input.manifest.capabilityBindings.toolNames = ['python.execute'];
    input.publication.definition.capabilities.toolNames = ['python.execute'];
    expect(freezeManagedPythonBinding(input)?.purposes).toEqual([
      'python_charts',
    ]);
    input.manifest.capabilityBindings.toolNames = ['cloud.process.execute'];
    input.publication.definition.capabilities.toolNames = [
      'cloud.process.execute',
    ];
    expect(freezeManagedPythonBinding(input)).toBeUndefined();
  });
  it('derives each purpose only from the matching frozen and published tool', () => {
    const input = fixture();
    input.manifest.capabilityBindings.toolNames.push('python.execute');
    input.publication.definition.capabilities.toolNames.push('python.execute');
    const original = JSON.stringify(input.manifest);
    expect(freezeManagedPythonBinding(input)?.purposes).toEqual([
      'office',
      'python_charts',
    ]);
    expect(JSON.stringify(input.manifest)).toBe(original);
    input.publication.definition.capabilities.toolNames = ['python.execute'];
    expect(freezeManagedPythonBinding(input)?.purposes).toEqual([
      'python_charts',
    ]);
    input.manifest.capabilityBindings.toolNames = ['workspace.export.create'];
    expect(freezeManagedPythonBinding(input)).toBeUndefined();
  });
  it('rejects runtime authority in editable bindings and preserves old frozen bindings without defaults', () => {
    const input = fixture(),
      bindings = input.manifest.capabilityBindings,
      bytes = JSON.stringify(bindings);
    expect(
      JSON.stringify(FrozenEmployeeCapabilityBindingsSchema.parse(bindings)),
    ).toBe(bytes);
    const delegated = {
      ...bindings,
      managedPython: freezeManagedOfficeBinding(input),
    };
    expect(
      FrozenEmployeeCapabilityBindingsSchema.safeParse(delegated).success,
    ).toBe(true);
    expect(EmployeeCapabilityBindingsSchema.safeParse(delegated).success).toBe(
      false,
    );
    expect(
      EmployeeDefinitionSchema.safeParse({
        ...input.manifest,
        capabilityBindings: delegated,
      }).success,
    ).toBe(false);
    expect(
      FrozenManagedPythonBindingSchema.safeParse({
        contractVersion: 1,
        profileVersion: 1,
        purposes: ['office'],
      }).success,
    ).toBe(false);
  });
});
