import type { DshNativeSkillSnapshot } from '@allrice/contracts';
import { readFrozenSkillResource } from '@allrice/database';

type Assignment = {
  expectedHead: { artifactId: string; digest: string };
  role: 'edit' | 'test' | 'review';
  paths?: string[];
};

/** Role instructions are immutable resources of this Run, not the live catalog.
 * The Bridge owns identities and receipts; this module only describes work. */
export function developmentAssignmentMessage(
  assignment: Assignment,
  assignmentId: string,
  skills: readonly DshNativeSkillSnapshot[],
) {
  const identity = `\nPlanned development assignment: ${JSON.stringify({ ...assignment, ...(assignment.role === 'edit' ? { assignmentId } : {}) })}`;
  const skill = skills.find(
    (skill) => skill.name === 'development-cooperation',
  );
  if (!skill) return identity + legacyInstructions(assignment);
  const resources = [
    'references/workflow.md',
    `references/${assignment.role}.md`,
    'references/delivery.md',
  ];
  return (
    identity +
    `\nFrozen development instructions (${skill.bundle?.version}, ${skill.bundle?.checksum}):\n` +
    resources
      .map((path) => {
        const resource = readFrozenSkillResource(skills, skill.name, path);
        return Buffer.from(resource.contentBase64, 'base64').toString('utf8');
      })
      .join('\n')
  );
}

// Compatibility only for historical packages without the new Skill. Retire
// when those published versions/runs no longer need recovery; do not expand.
function legacyInstructions(assignment: Assignment) {
  return (
    (assignment.role !== 'edit'
      ? `\nInspect your assigned candidate using exactly ${JSON.stringify({ action: 'inspect', candidate: assignment.expectedHead })}. Do not pass assignmentId: it is only for an editor's file claim, not a verifier assignment. An argument-validation response means correct the syntax, not bypass a policy denial. For your final assistant.report, use evidence=[] and output={name:"verification-result",content:"your summary citing actual operation/review references"}; a root candidate, command operation or review ID is NOT an artifact registered to your child. Formal testing/review still require their actual platform records, not this report text.`
      : '') +
    (assignment?.role === 'edit'
      ? '\nPublication protocol: wrap each action object as the JSON string command argument to assistant.development. For your FIRST publish, previous MUST be null, never expectedHead/base. Only revising your own successful published proposal uses that proposal reference as previous. before/after are exact text strings or null, not {text,checksum} objects. Preserve actual newlines from inspect; do not double-escape them into literal backslash-n.'
      : '') +
    (assignment?.role === 'test'
      ? '\nApproval protocol: call local.process.execute with the exact assigned candidate and command to REQUEST approval. That call creates the web approval card; it is not permission to execute. The platform waits for the user and only dispatches after approval. Do not wait for a nonexistent card before submitting, and do not report partial merely because approval has not yet been requested. Report success only from the returned terminal command receipt; preserve a real rejection, cancellation or timeout as incomplete.'
      : '')
  );
}
