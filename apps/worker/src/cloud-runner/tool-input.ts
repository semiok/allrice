import {
  CloudCommandInputSchema,
  SkillResourcePathSchema,
} from '@allrice/contracts';
import { z } from 'zod';

export const FrozenCloudScriptReferenceSchema = z
  .object({
    skill: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    path: SkillResourcePathSchema.refine(
      (path) => path.startsWith('scripts/') && /\.m?js$/.test(path),
    ),
  })
  .strict();

// Public tool input only. The durable CloudCommand remains exact inline bytes.
// A reference cannot select another Run, version, catalog, URL or host path.
export const CloudToolInputSchema = z.union([
  CloudCommandInputSchema,
  z
    .object({
      frozenScript: FrozenCloudScriptReferenceSchema,
      inputs: CloudCommandInputSchema.shape.inputs,
      outputs: CloudCommandInputSchema.shape.outputs,
      limits: CloudCommandInputSchema.shape.limits,
    })
    .strict(),
]);
