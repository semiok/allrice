import type { TaskNextSteps, TaskNextStepsInput } from '@allrice/contracts';

export function taskNextStepsMatchScope(
  data: TaskNextSteps,
  input: TaskNextStepsInput & { organizationId: string; viewerId: string },
) {
  return Object.entries(input).every(
    ([key, value]) => data.scope[key as keyof typeof input] === value,
  );
}
