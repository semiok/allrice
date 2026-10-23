import { z } from 'zod';
import { UuidSchema } from '@allrice/contracts';
import { EmployeeRunExecutionBindingSchema } from './current-execution-binding.ts';
import { PlatformTestExecutionBindingSchema } from './current-platform-test-binding.ts';

/** Private result of the leased SQL prepare closure. The test binding is the
 * immutable first-INSERT fact; Run/Job/attempt are joined only after claim.
 * This is never accepted from a browser, tool, kernel or native RPC. */
export const LeasedPlatformTestExecutionBindingSchema = z
  .object({
    kind: z.literal('current_platform_test_run_execution'),
    test: PlatformTestExecutionBindingSchema,
    runId: UuidSchema,
    jobId: UuidSchema,
    attempt: z.number().int().positive(),
  })
  .strict();
export type LeasedPlatformTestExecutionBinding = z.infer<
  typeof LeasedPlatformTestExecutionBindingSchema
>;
export const NativeRunExecutionBindingSchema = z.union([
  EmployeeRunExecutionBindingSchema,
  LeasedPlatformTestExecutionBindingSchema,
]);
export type NativeRunExecutionBinding = z.infer<
  typeof NativeRunExecutionBindingSchema
>;
