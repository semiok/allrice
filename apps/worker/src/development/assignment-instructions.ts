import type { DshNativeSkillSnapshot } from '@allrice/contracts';
import { readFrozenSkillResource } from '@allrice/database';

type Assignment = {
  expectedHead: { artifactId: string; digest: string };
  role: 'edit' | 'test' | 'review';
  paths?: string[];
};

/** Only a certified platform repository review may use this server-selected
 * protocol. Its review artifact is registered to the actual child; the local
 * command workflow's output-only compatibility instructions do not apply. */
export function repositoryReviewAssignmentMessage(assignment: Assignment) {
  if (assignment.role !== 'review')
    throw Error('repository_review_role_required');
  return `\nPlanned repository review assignment: ${JSON.stringify(assignment)}
Use assistant.development's native envelope {command: JSON.stringify(action)} for each action.
The tool response's development field contains that action's result; read its actual references.
First inspect exactly ${JSON.stringify({ action: 'inspect', candidate: assignment.expectedHead })}. Read the saved patch, original CI receipts and author provenance. Do not execute, edit, publish, merge or deploy.
Record your attributed opinion with {action:"review",candidate:YOUR_ASSIGNED_CANDIDATE,evidence:THE_EXACT_INSPECT_EVIDENCE,verdict:"accept"|"revise",summary:"your review"}. Use the returned immutable artifact reference; a review UUID or prose is not a registered artifact.
For your final assistant.report, include evidence=[{id:reviewResult.artifact.artifactId,digest:reviewResult.artifact.digest}] and summary. Do not report with empty evidence or substitute an output-only summary. If the opinion could not be saved, report incomplete and preserve the actual error.`;
}

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
