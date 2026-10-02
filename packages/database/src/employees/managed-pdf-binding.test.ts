import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EmployeeCapabilityBindingsSchema,
  EmployeeDefinitionSchema,
  PlatformEmployeeDefinitionSchema,
} from '@allrice/contracts';
import { employeeManifest } from './employee-config.ts';
import { freezeManagedPdfBinding } from './managed-pdf-binding.ts';

function fixture() {
  const manifest = EmployeeDefinitionSchema.parse(
    employeeManifest({
      key: 'pdf-reader',
      name: '文档阅读',
      description: '只读',
      toolNames: ['workspace.document.read'],
    }),
  );
  manifest.capabilities = ['storage:read'];
  manifest.securityPolicy.deniedCapabilities = ['storage:write'];
  const definition = PlatformEmployeeDefinitionSchema.parse({
    schemaVersion: 1,
    key: 'pdf-reader',
    name: '文档阅读',
    description: '只读',
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
      toolNames: ['workspace.document.read'],
      connectorRefs: [],
    },
    securityPolicy: { ...manifest.securityPolicy, bridgeAccess: 'read_only' },
  });
  return {
    manifest,
    grantedCapabilities: ['storage:read' as const],
    publication: {
      revisionId: randomUUID(),
      checksum: `sha256:${'a'.repeat(64)}`,
      definition,
    },
  };
}
describe('publication-derived read-only PDF authority', () => {
  it('supports ordinary read-only access without changing original manifest bytes', () => {
    const input = fixture(),
      before = JSON.stringify(input.manifest);
    const binding = freezeManagedPdfBinding(input);
    expect(binding).toEqual({
      contractVersion: 1,
      profileVersion: 1,
      publication: {
        revisionId: input.publication.revisionId,
        checksum: input.publication.checksum,
      },
    });
    expect(JSON.stringify(input.manifest)).toBe(before);
    expect(
      EmployeeCapabilityBindingsSchema.safeParse({
        ...input.manifest.capabilityBindings,
        managedPdf: binding,
      }).success,
    ).toBe(false);
  });
  it.each(['frozen', 'published'] as const)(
    'respects %s removal and storage-read denial',
    (source) => {
      const input = fixture();
      if (source === 'frozen') input.manifest.capabilityBindings.toolNames = [];
      else input.publication.definition.capabilities.toolNames = [];
      expect(freezeManagedPdfBinding(input)).toBeUndefined();
      const denied = fixture();
      (source === 'frozen'
        ? denied.manifest.securityPolicy
        : denied.publication.definition.securityPolicy
      ).deniedCapabilities.push('storage:read');
      expect(freezeManagedPdfBinding(denied)).toBeUndefined();
    },
  );
  it('requires actual publication provenance and granted source-read authority', () => {
    const input = fixture();
    expect(
      freezeManagedPdfBinding({ ...input, publication: null }),
    ).toBeUndefined();
    expect(
      freezeManagedPdfBinding({ ...input, grantedCapabilities: [] }),
    ).toBeUndefined();
    expect(
      freezeManagedPdfBinding({
        ...input,
        publication: { ...input.publication, checksum: 'invalid' },
      }),
    ).toBeUndefined();
    input.publication.definition.securityPolicy.bridgeAccess = 'none';
    expect(freezeManagedPdfBinding(input)).toBeUndefined();
  });
});
