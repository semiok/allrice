import { describe, expect, it } from 'vitest';
import { estimateConversationTokens } from '@allrice/database';
import { employeeRunModelInput } from './employee-run.js';
import {
  assertInitialModelInputBudget,
  modelAdmissionTokenEstimate,
} from '../model-result-budget.js';
import { mcpCatalogAdmissionInstructions } from '../harness/dsh/native-tools.js';

const legacyKernel = {
  systemInstructions: 'GENERIC_POLICY',
  rootSystemInstructions: 'ROOT_POLICY',
  employeeDocuments: {
    user: '# USER.md\nUSER_FACTS',
    memory: '# MEMORY.md\nCONFIRMED_MEMORY',
  },
  bootstrapConversation: 'HISTORY',
  authorizedMemoryContext: 'AUTHORIZED_REFERENCES',
  userRequest: 'CURRENT_REQUEST',
};

describe('employee first-call input estimates', () => {
  it('preserves the old USER/MEMORY input bytes when persona is absent or empty', () => {
    const original =
      'ROOT_POLICY\n# USER.md\nUSER_FACTS\n# MEMORY.md\nCONFIRMED_MEMORY\nHISTORY\nAUTHORIZED_REFERENCES\nCURRENT_REQUEST';
    expect(employeeRunModelInput(legacyKernel)).toBe(original);
    expect(
      employeeRunModelInput({
        ...legacyKernel,
        employeeDocuments: { ...legacyKernel.employeeDocuments, persona: '' },
      }),
    ).toBe(original);
    expect(
      employeeRunModelInput({
        ...legacyKernel,
        rootSystemInstructions: undefined,
      }),
    ).toBe(original.replace('ROOT_POLICY', 'GENERIC_POLICY'));
  });

  it('includes the full literal PERSONA in admission telemetry without restoring old input limits', () => {
    const persona = '# PERSONA.md\n' + '人设 {{literal}}\n'.repeat(200);
    const input = employeeRunModelInput({
      ...legacyKernel,
      employeeDocuments: { ...legacyKernel.employeeDocuments, persona },
    });
    expect(input).toContain(persona);
    expect(input.indexOf('# PERSONA.md')).toBeLessThan(
      input.indexOf('# USER.md'),
    );
    expect(input.indexOf('# USER.md')).toBeLessThan(input.indexOf('# MEMORY.md'));
    const estimatedInputTokens = estimateConversationTokens(input);
    const legacyTokens = estimateConversationTokens(
      employeeRunModelInput(legacyKernel),
    );
    expect(estimatedInputTokens).toBeGreaterThan(legacyTokens);
    const scope = {
      verifiedSubscription: false,
      workflow: false,
      limits: {
        timeoutMs: 60000,
        maxInputTokens: 1,
        maxOutputTokens: 100,
        maxTotalTokens: 101,
        maxCostCents: 1,
      },
      estimatedInputTokens,
    };
    expect(modelAdmissionTokenEstimate(scope)).toBe(estimatedInputTokens + 100);
    expect(() => assertInitialModelInputBudget(scope)).not.toThrow();
  });

  it('keeps persona, routed root policy, MCP guidance and authorized references in the routed estimate', () => {
    const persona = '# PERSONA.md\nFROZEN_PERSONA {{literal}}';
    const mcpToolCatalog = [
      {
        connectionId: '00000000-0000-4000-8000-000000000001',
        name: 'read_case',
        description: 'Read the authorized case',
        inputSchema: { type: 'object' },
        risk: 'read_only' as const,
      },
    ];
    const routed = employeeRunModelInput({
      ...legacyKernel,
      systemInstructions: 'GENERIC_POLICY\nROUTE',
      rootSystemInstructions: 'ROOT_POLICY\nROUTE',
      employeeDocuments: { ...legacyKernel.employeeDocuments, persona },
      authorizedMemoryContext: 'AUTHORIZED_REFERENCES\nKNOWLEDGE',
      mcpToolCatalog,
    });
    expect(routed).toContain('ROOT_POLICY\nROUTE\n' + persona);
    expect(routed).not.toContain('GENERIC_POLICY');
    expect(routed).toContain(mcpCatalogAdmissionInstructions(mcpToolCatalog));
    expect(routed).toContain('AUTHORIZED_REFERENCES\nKNOWLEDGE\nCURRENT_REQUEST');
    expect(estimateConversationTokens(routed)).toBeGreaterThan(
      estimateConversationTokens(employeeRunModelInput(legacyKernel)),
    );
  });
});
