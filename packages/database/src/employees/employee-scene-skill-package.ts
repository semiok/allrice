import type {
  EmployeeContentReference,
  EmployeeSceneSkillPayload,
} from '@allrice/contracts';
import {
  validateSkillBundle,
  validateHistoricalSkillBundle,
} from '../skill-bundles.ts';
import { EmployeeContentError } from './employee-content-model.ts';
import { parseWorkflowSkillSections } from './workflow-skill.ts';

const referenceKey = (ref: EmployeeContentReference) =>
  `${ref.sourceKind}:${ref.contentId}:${ref.revisionId}:${ref.digest}`;

/** Package-owned bytes follow content ownership. Controlled source bytes also
 * retain their exact reference, which the content reader must authorize. */
export function validateSceneSkillPackage(
  payload: EmployeeSceneSkillPayload,
  body: string,
  references: readonly EmployeeContentReference[],
) {
  return validateScenePackage(payload, body, references, false);
}

/** Read a digest-bound published revision; preserve all bytes and source checks. */
export function validateHistoricalSceneSkillPackage(
  payload: EmployeeSceneSkillPayload,
  body: string,
  references: readonly EmployeeContentReference[],
) {
  return validateScenePackage(payload, body, references, true);
}

function validateScenePackage(
  payload: EmployeeSceneSkillPayload,
  body: string,
  references: readonly EmployeeContentReference[],
  historical: boolean,
) {
  if (payload.frontmatter) {
    try {
      parseWorkflowSkillSections(body);
    } catch {
      throw new EmployeeContentError('workflow_invalid');
    }
  }
  try {
    if (historical) validateHistoricalSkillBundle(payload.bundle, body);
    else validateSkillBundle(payload.bundle, body);
    const declared = new Set(references.map(referenceKey));
    if (
      payload.resourceSources.some((source) =>
        source.references.some((ref) => !declared.has(referenceKey(ref))),
      )
    )
      throw Error('undeclared_resource_source');
  } catch {
    throw new EmployeeContentError('validation_failed');
  }
}
