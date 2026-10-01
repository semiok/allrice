import { z } from 'zod';
import { CloudCommandInputSchema } from './runtime-v2/cloud-command.ts';

/** Canonical local-first computation. Parsing never injects a language/location
 * into the original tool call; only the execution adapter normalizes them. */
export const PythonExecuteArgsSchema = z
  .object({
    ...CloudCommandInputSchema.shape,
    language: z.literal('python').optional(),
    location: z.enum(['auto', 'local', 'cloud']).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { location: _location, ...command } = value;
    void _location;
    const result = CloudCommandInputSchema.safeParse({
      ...command,
      language: 'python',
    });
    if (!result.success)
      for (const issue of result.error.issues)
        ctx.addIssue({
          code: 'custom',
          path: issue.path,
          message: issue.message,
        });
  });
export type PythonExecuteArgs = z.infer<typeof PythonExecuteArgsSchema>;
