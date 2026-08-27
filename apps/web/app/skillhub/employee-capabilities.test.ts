import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildEmployeeCapabilityUpdate } from './employee-capabilities.js';

describe('SkillHub employee capability updates', () => {
  it('adds an Agent Skill without clearing Workflow or Knowledge bindings', () => {
    const employeeId = randomUUID();
    const existingSkill = randomUUID();
    const existingInstallation = randomUUID();
    const workflow = randomUUID();
    const knowledge = randomUUID();
    const installation = {
      id: randomUUID(),
      pinnedVersionId: randomUUID(),
      grantedCapabilities: ['network:outbound' as const],
    };
    const update = buildEmployeeCapabilityUpdate(
      {
        employeeId,
        agentSkills: [
          {
            installationId: existingInstallation,
            revision: { id: existingSkill },
            grantedCapabilities: ['storage:read'],
          },
        ],
        workflows: [{ revision: { id: workflow } }],
        knowledge: [{ revision: { id: knowledge } }],
      },
      installation,
      true,
    );
    expect(update.agentSkills).toHaveLength(2);
    expect(update.agentSkills.at(-1)).toMatchObject({
      installationId: installation.id,
      skillVersionId: installation.pinnedVersionId,
    });
    expect(update.workflowRevisionIds).toEqual([workflow]);
    expect(update.knowledgeRevisionIds).toEqual([knowledge]);
  });

  it('removes only the selected Agent Skill binding', () => {
    const targetVersion = randomUUID();
    const targetInstallation = randomUUID();
    const retainedVersion = randomUUID();
    const retainedInstallation = randomUUID();
    const update = buildEmployeeCapabilityUpdate(
      {
        employeeId: randomUUID(),
        agentSkills: [
          {
            installationId: targetInstallation,
            revision: { id: targetVersion },
            grantedCapabilities: ['network:outbound'],
          },
          {
            installationId: retainedInstallation,
            revision: { id: retainedVersion },
            grantedCapabilities: ['storage:read'],
          },
        ],
        workflows: [],
        knowledge: [],
      },
      {
        id: targetInstallation,
        pinnedVersionId: targetVersion,
        grantedCapabilities: ['network:outbound'],
      },
      false,
    );
    expect(update.agentSkills).toEqual([
      {
        installationId: retainedInstallation,
        skillVersionId: retainedVersion,
        grantedCapabilities: ['storage:read'],
      },
    ]);
  });

  it('drops an unavailable historic binding when another skill is changed', () => {
    const installation = {
      id: randomUUID(),
      pinnedVersionId: randomUUID(),
      grantedCapabilities: ['storage:read' as const],
    };
    const update = buildEmployeeCapabilityUpdate(
      {
        employeeId: randomUUID(),
        agentSkills: [
          {
            installationId: randomUUID(),
            revision: { id: randomUUID() },
            grantedCapabilities: ['network:outbound'],
            effective: false,
          },
        ],
        workflows: [],
        knowledge: [],
      },
      installation,
      true,
    );
    expect(update.agentSkills).toEqual([
      {
        installationId: installation.id,
        skillVersionId: installation.pinnedVersionId,
        grantedCapabilities: installation.grantedCapabilities,
      },
    ]);
  });
});
