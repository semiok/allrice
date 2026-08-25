import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AgentSkillRevisionSchema,
  KnowledgeDefinitionSchema,
  ManageEmployeeCapabilitiesInputSchema,
  WorkflowDefinitionSchema,
} from './capabilities.js';

describe('Agent capability contracts', () => {
  it('freezes an Agent Skill revision with source and checksum', () => {
    const revision = AgentSkillRevisionSchema.parse({
      kind: 'agent_skill',
      id: randomUUID(),
      agentSkillId: randomUUID(),
      slug: 'web-research',
      name: '联网研究',
      description: '在授权范围内查找公开资料。',
      publisher: 'AllRice',
      revision: '1.0.0',
      status: 'published',
      checksum: `sha256:${'a'.repeat(64)}`,
      source: {
        repository: 'https://github.com/semiok/allrice',
        commit: 'b'.repeat(40),
        path: 'skills/web-research',
        license: 'Apache-2.0',
      },
      metadata: {
        applicableScenarios: ['研究公开资料'],
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        requiredToolRefs: ['web-search'],
        riskLevel: 'medium',
      },
      declaredCapabilities: ['network:outbound', 'storage:read'],
      publishedAt: '2026-08-25T00:00:00.000Z',
    });
    expect(revision.kind).toBe('agent_skill');
    expect(revision.source.commit).toHaveLength(40);
  });

  it('validates workflow graph references independently of Skills', () => {
    const definition = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      steps: [
        { key: 'research', name: '研究', kind: 'knowledge' },
        {
          key: 'review',
          name: '人工确认',
          kind: 'approval',
          dependsOn: ['research'],
        },
      ],
    });
    expect(definition.steps[1]?.dependsOn).toEqual(['research']);
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        steps: [
          {
            key: 'publish',
            name: '发布',
            kind: 'tool',
            dependsOn: ['missing'],
          },
        ],
      }),
    ).toThrow('workflow dependencies must reference another step');
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        steps: [
          { key: 'one', name: '一', kind: 'model', dependsOn: ['two'] },
          { key: 'two', name: '二', kind: 'model', dependsOn: ['one'] },
        ],
      }),
    ).toThrow('workflow dependencies must form an acyclic graph');
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        steps: [
          {
            key: 'publish',
            name: '发布',
            kind: 'tool',
            sideEffect: 'non_idempotent',
          },
        ],
      }),
    ).toThrow('non-idempotent workflow steps require compensation');
    expect(
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        steps: [
          {
            key: 'publish',
            name: '发布',
            kind: 'tool',
            sideEffect: 'idempotent',
            approval: 'required',
          },
        ],
      }).steps[0],
    ).toMatchObject({ sideEffect: 'idempotent', approval: 'required' });
  });

  it('requires connector Knowledge to use an opaque binding ID', () => {
    expect(() =>
      KnowledgeDefinitionSchema.parse({
        schemaVersion: 1,
        sourceKind: 'connector',
        resourceRef: 'drive://folder/roadmap',
        allowedScopes: ['workspace'],
      }),
    ).toThrow('connector knowledge requires an opaque connector binding ID');
    expect(
      KnowledgeDefinitionSchema.parse({
        schemaVersion: 1,
        sourceKind: 'connector',
        connectorBindingId: randomUUID(),
        resourceRef: 'drive://folder/roadmap',
        allowedScopes: ['workspace', 'employee'],
      }).citationRequired,
    ).toBe(true);
  });

  it('accepts only immutable capability revision IDs in employee bindings', () => {
    const input = ManageEmployeeCapabilitiesInputSchema.parse({
      workspaceId: randomUUID(),
      employeeId: randomUUID(),
      agentSkills: [
        {
          installationId: randomUUID(),
          skillVersionId: randomUUID(),
          grantedCapabilities: ['network:outbound'],
        },
      ],
      workflowRevisionIds: [randomUUID()],
      knowledgeRevisionIds: [randomUUID()],
    });
    expect(input.agentSkills).toHaveLength(1);
    expect(() =>
      ManageEmployeeCapabilitiesInputSchema.parse({
        workspaceId: randomUUID(),
        employeeId: randomUUID(),
        workflowRevisionIds: ['weekly-report@latest'],
      }),
    ).toThrow();
  });
});
