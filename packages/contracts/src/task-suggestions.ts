import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { SkillCapabilitySchema } from './skills.ts';
import { WorkspaceCapabilityIdSchema } from './workspace-readiness.ts';

const slotName = /^[\p{L}\p{N}_-]{1,64}$/u;
export const TaskSuggestionSlotSchema = z
  .object({
    name: z.string().regex(slotName),
    label: z.string().trim().min(1).max(120),
    required: z.boolean().optional(),
    defaultValue: z.string().trim().min(1).max(2_000).optional(),
    options: z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .max(8)
      .optional(),
  })
  .strict()
  .superRefine((slot, context) => {
    if (slot.options && new Set(slot.options).size !== slot.options.length)
      context.addIssue({
        code: 'custom',
        path: ['options'],
        message: '参数选项不能重复',
      });
    if (
      slot.options &&
      slot.defaultValue &&
      !slot.options.includes(slot.defaultValue)
    )
      context.addIssue({
        code: 'custom',
        path: ['defaultValue'],
        message: '默认值必须来自参数选项',
      });
  });
export type TaskSuggestionSlot = z.infer<typeof TaskSuggestionSlotSchema>;

/** Discovery metadata only; these references never grant execution authority. */
export const TaskSuggestionRequirementsSchema = z
  .object({
    toolNames: z.array(z.string().trim().min(1).max(160)).max(16).optional(),
    nativeSkillIds: z.array(UuidSchema).max(8).optional(),
    capabilities: z.array(SkillCapabilitySchema).max(8).optional(),
    readiness: z.array(WorkspaceCapabilityIdSchema).max(4).optional(),
  })
  .strict();
export const TaskSuggestionPreparationSchema = z.enum([
  'files',
  'bridge',
  'connections',
]);

export const TaskSuggestionDisplaySchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    title: z.string().trim().min(1).max(60),
    description: z.string().trim().min(1).max(300).optional(),
    template: z.string().trim().min(1).max(8_000),
    slots: z.array(TaskSuggestionSlotSchema).max(8).optional(),
    preparation: z.array(TaskSuggestionPreparationSchema).max(3).optional(),
    readiness: z.array(WorkspaceCapabilityIdSchema).max(4).optional(),
  })
  .strict();
export type TaskSuggestionDisplay = z.infer<typeof TaskSuggestionDisplaySchema>;

export const TaskSuggestionSchema = TaskSuggestionDisplaySchema.omit({
  readiness: true,
})
  .extend({ requires: TaskSuggestionRequirementsSchema.optional() })
  .superRefine((suggestion, context) => {
    const names = (suggestion.slots ?? []).map((slot) => slot.name);
    if (new Set(names).size !== names.length)
      context.addIssue({
        code: 'custom',
        path: ['slots'],
        message: '同一任务的参数名称不能重复',
      });
    const refs = [...suggestion.template.matchAll(/\{\{([^{}]+)\}\}/gu)].map(
      (match) => match[1]!,
    );
    if (suggestion.template.replace(/\{\{[^{}]+\}\}/gu, '').match(/\{\{|\}\}/u))
      context.addIssue({
        code: 'custom',
        path: ['template'],
        message: '模板参数请使用 {{参数名}}',
      });
    for (const ref of new Set(refs))
      if (!names.includes(ref))
        context.addIssue({
          code: 'custom',
          path: ['template'],
          message: `参数 {{${ref}}} 未在 slots 中配置`,
        });
    names.forEach((name, index) => {
      if (!refs.includes(name))
        context.addIssue({
          code: 'custom',
          path: ['slots', index, 'name'],
          message: `参数 ${name} 未在模板中使用`,
        });
    });
  });
export type TaskSuggestion = z.infer<typeof TaskSuggestionSchema>;

// Do not default this optional field: historical definitions/checksums are immutable.
export const TaskSuggestionsSchema = z
  .array(TaskSuggestionSchema)
  .max(8)
  .superRefine((suggestions, context) => {
    const ids = new Set<string>();
    suggestions.forEach((suggestion, index) => {
      if (ids.has(suggestion.id))
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: '推荐任务 id 不能重复',
        });
      ids.add(suggestion.id);
    });
  });
