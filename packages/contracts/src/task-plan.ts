import { z } from 'zod';

/** Public DSH todo snapshots, not private reasoning or execution receipts. */
export const TaskPlanItemsSchema = z.array(
  z.object({
    content: z.string().trim().min(1),
    status: z.enum(['pending', 'in_progress', 'completed']),
  }),
);
export type TaskPlanItem = z.infer<typeof TaskPlanItemsSchema>[number];
