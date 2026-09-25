import { z } from 'zod';
import { UuidSchema } from './common.ts';

export const WorkAutomationSchema = z
  .object({
    cloud: z.boolean(),
    computer: z.boolean(),
    assistants: z.boolean(),
  })
  .strict();
export type WorkAutomation = z.infer<typeof WorkAutomationSchema>;
export const defaultWorkAutomation: WorkAutomation = {
  cloud: true,
  computer: true,
  assistants: true,
};
export const WorkAutomationViewSchema = z
  .object({
    workspaceId: UuidSchema,
    revision: z.number().int().nonnegative(),
    settings: WorkAutomationSchema,
    editable: z.boolean(),
  })
  .strict();
export const UpdateWorkAutomationSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    capability: z.enum(['cloud', 'computer', 'assistants']),
    enabled: z.boolean(),
  })
  .strict();

/** Scope is determined by the registered action, never by model text. */
export function workAutomationGroup(
  action: string,
): keyof WorkAutomation | null {
  if (action === 'assistant.delegate') return 'assistants';
  if (
    [
      'local.fs.write',
      'local.fs.mkdir',
      'local.fs.changeset',
      'local.process.execute',
      'local.mcp.discover',
      'local.mcp.call',
      'local.browser.act',
    ].includes(action)
  )
    return 'computer';
  if (
    ['cloud.process.execute', 'cloud.mcp.call', 'cloud.browser.act'].includes(
      action,
    )
  )
    return 'cloud';
  return null;
}
