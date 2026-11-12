import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadedExperienceSkillEvidence } from './experience-evidence.ts';

describe('personal Skill provenance uses a successful exact frozen pin', () => {
  const pin = {
    organizationId: randomUUID(),
    ownerId: randomUUID(),
    instanceId: randomUUID(),
    installationId: randomUUID(),
    versionId: randomUUID(),
    bindingId: randomUUID(),
    bindingEpoch: 2,
    definitionChecksum: `sha256:${'a'.repeat(64)}`,
    packageChecksum: `sha256:${'b'.repeat(64)}`,
  };
  const run = {
    run_id: randomUUID(),
    execution_snapshot: { personalSkills: { skills: [pin] } },
  };
  const event = {
    id: randomUUID(),
    event_type: 'tool.completed',
    payload: {
      name: 'skill',
      nativePayload: { skillStatus: 'loaded', personalSkill: pin },
    },
  };
  it('keeps the exact Run, event and version; duplicate loads do not multiply dependencies', () => {
    expect(loadedExperienceSkillEvidence(run, [event, event])).toEqual([
      { runId: run.run_id, eventId: event.id, pin },
    ]);
  });
  it('does not infer use from available pins, failure, selected state, prose or a changed version', () => {
    for (const events of [
      [],
      [{ ...event, event_type: 'tool.failed' }],
      [
        {
          ...event,
          payload: {
            name: 'skill',
            nativePayload: { skillStatus: 'selected', personalSkill: pin },
          },
        },
      ],
      [{ ...event, payload: { text: 'skill loaded' } }],
      [
        {
          ...event,
          payload: {
            name: 'skill',
            nativePayload: {
              skillStatus: 'loaded',
              personalSkill: { ...pin, bindingEpoch: 3 },
            },
          },
        },
      ],
    ])
      expect(loadedExperienceSkillEvidence(run, events)).toEqual([]);
    expect(
      loadedExperienceSkillEvidence({ ...run, execution_snapshot: {} }, [
        event,
      ]),
    ).toEqual([]);
  });
});
