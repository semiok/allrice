import { z } from 'zod';
import { UuidSchema } from './common.ts';

export const WorkbenchFileSharingSchema = z
  .object({
    scope: z.enum(['personal', 'departments', 'company']),
    departmentIds: z.array(UuidSchema).max(64).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.scope === 'departments') !== value.departmentIds.length > 0 ||
      new Set(value.departmentIds).size !== value.departmentIds.length
    )
      ctx.addIssue({
        code: 'custom',
        message: '指定部门时请选择至少一个不重复的部门；其他范围无需选择部门。',
      });
  });

export type WorkbenchFileSharing = z.infer<typeof WorkbenchFileSharingSchema>;
