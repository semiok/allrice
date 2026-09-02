import { describe, expect, it } from 'vitest';

import { HandlerError } from '../errors.js';
import { executeEmployeeRun } from './employee-run.js';
import { resolveJobHandler } from './dispatch.js';
import { executeSystemEcho } from './system-echo.js';
import { executeWorkflowRun } from './workflow-run.js';

describe('Worker job handler dispatch', () => {
  it('maps every supported payload to its dedicated handler', () => {
    expect(resolveJobHandler('allrice.employee.run')).toBe(executeEmployeeRun);
    expect(resolveJobHandler('allrice.workflow.run')).toBe(executeWorkflowRun);
    expect(resolveJobHandler('allrice.system.echo')).toBe(executeSystemEcho);
  });

  it('keeps unsupported jobs on the canonical non-retryable failure', () => {
    expect(() => resolveJobHandler('allrice.unknown')).toThrowError(
      HandlerError,
    );
    try {
      resolveJobHandler('allrice.unknown');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'UNSUPPORTED_JOB_TYPE',
        retryable: false,
      });
    }
  });
});
