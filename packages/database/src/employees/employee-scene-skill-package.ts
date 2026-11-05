import type {
  EmployeeContentReference,
  EmployeeSceneSkillPayload,
} from '@allrice/contracts';
import { validateSkillBundle } from '../skill-bundles.ts';
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
  try {
    validateSkillBundle(payload.bundle, body);
    if (payload.frontmatter) parseWorkflowSkillSections(body);
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
