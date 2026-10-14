import { EmployeeMethodFileStepSchema } from '@allrice/contracts';

/** Private to the isolated candidate-test harness, absent from employee skills
 * and the public tool manifest. The host verifies actual test/lease identity. */
export const methodTestNativeTools = [
  {
    canonicalName: 'platform.employee.method.step',
    wireName: 'platform_employee_method_step',
    description:
      'Execute one step of the selected candidate in the fixed isolated JavaScript file case. Apply the candidate as written; do not repair its order or arithmetic to obtain a pass. normalize receives input/amounts.csv (entryId,amountCents) and writes output/normalized.json with {currency:"CNY",amountUnit:"cent",rows:[{entryId,amountCents}]}. summarize receives input/normalized.json and writes output/summary.csv with header currency,amountUnit,totalCents and one data row. Scripts run as Node ES modules, cwd /tmp/work; use node:fs. Only the declared input/output is supplied/collected; no network or company files. Each stage executes at most once. Identical retries reconcile the existing operation, never re-execute it. A wrong stage or incorrect file is retained as failure. Return actual files, not a textual claim.',
    timeoutMs: 120000,
    isConcurrencySafe: false,
    parameters: {
      stage: {
        type: 'string',
        required: true,
        enum: ['normalize', 'summarize'],
      },
      script: { type: 'string', required: true },
    },
    validateArguments: (args) => EmployeeMethodFileStepSchema.parse(args),
  },
];
