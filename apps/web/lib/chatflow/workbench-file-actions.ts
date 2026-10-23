import { z } from 'zod';
import { WorkbenchFileCatalogSchema, UuidSchema } from '@allrice/contracts';

/** Web-only action projection. Missing availability fails closed on old responses. */
export const WorkbenchFileActionsCatalogSchema =
  WorkbenchFileCatalogSchema.extend({
    quotableFileIds: z.array(UuidSchema).default([]),
  });
export type WorkbenchFileActionsCatalog = z.infer<
  typeof WorkbenchFileActionsCatalogSchema
>;
