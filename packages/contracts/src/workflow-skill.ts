import { z } from 'zod';

/** Authoring fields returned by the public DSH parser. These are content,
 * never an actor, permission, publication identity or execution credential. */
export const WorkflowSkillFrontmatterSchema = z
  .object({
    // Same technical name format as rc.2 isSkillName; no extra length limit.
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().min(1),
    whenToUse: z.string().min(1),
    invocation: z
      .object({ modelInvocable: z.boolean(), userInvocable: z.boolean() })
      .strict(),
    metadata: z
      .object({
        displayName: z.string().min(1).max(160),
        version: z.string().min(1),
      })
      .catchall(z.json()),
  })
  .strict();
export type WorkflowSkillFrontmatter = z.infer<
  typeof WorkflowSkillFrontmatterSchema
>;

export const workflowSkillInvalidMessage = '该技能不符合 workflow 规范。';
