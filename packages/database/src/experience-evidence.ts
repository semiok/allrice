import {
  PersonalSkillPinSchema,
  type ExperienceEvidence,
  type PersonalSkillPin,
} from '@allrice/contracts';
import type { getDatabase } from './core/client.ts';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Native completion is evidence only when its exact identity matches the
 * server-frozen pins. Shared by ordinary source capture and internal tests. */
export function matchSuccessfulPersonalSkillLoad(
  pins: PersonalSkillPin[],
  event: { type: string; name?: string; sourcePayload?: unknown },
) {
  const native = record(event.sourcePayload);
  if (
    event.type !== 'tool.completed' ||
    event.name !== 'skill' ||
    native.skillStatus !== 'loaded'
  )
    return undefined;
  const parsed = PersonalSkillPinSchema.safeParse(native.personalSkill);
  if (!parsed.success) return undefined;
  const p = parsed.data;
  return pins.find(
    (pin) =>
      Object.keys(pin).every(
        (key) => pin[key as keyof typeof pin] === p[key as keyof typeof p],
      ) && Object.keys(p).length === Object.keys(pin).length,
  );
}

/** Only successful actual Skill loads matched against that Run's immutable pin
 * count as dependencies. Mere registration, model prose and tool text do not. */
export function loadedExperienceSkillEvidence(
  run: { run_id: string; execution_snapshot: unknown },
  events: { id: string; event_type: string; payload: unknown }[],
): ExperienceEvidence['skills'] {
  const snapshot = record(run.execution_snapshot);
  const skills = record(snapshot.personalSkills).skills;
  const pins = Array.isArray(skills)
    ? skills.flatMap((item) => {
        const pin = PersonalSkillPinSchema.safeParse(item);
        return pin.success ? [pin.data] : [];
      })
    : [];
  const found = new Set<string>();
  return events.flatMap((event) => {
    const payload = record(event.payload);
    const pin = matchSuccessfulPersonalSkillLoad(pins, {
      type: event.event_type,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      sourcePayload: payload.nativePayload,
    });
    if (!pin || found.has(pin.bindingId)) return [];
    found.add(pin.bindingId);
    return [{ runId: run.run_id, eventId: event.id, pin }];
  });
}

/** The legacy collector never consumes pending or historical sources again. */
export async function collectPendingExperienceEvidence(
  options: {
    database?: ReturnType<typeof getDatabase>;
    limit?: number;
  } = {},
) {
  void options;
  return { captured: 0, ignored: 0, busy: 0 };
}
