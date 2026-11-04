import { describe, expect, it } from 'vitest';

import { HandlerError } from '../errors.js';
import { executeEmployeeRun } from './employee-run.js';
import { resolveJobHandler } from './dispatch.js';
import { executeSystemEcho } from './system-echo.js';

describe('Worker job handler dispatch', () => {
  it('maps every supported payload to its dedicated handler', () => {
    expect(resolveJobHandler('allrice.employee.run')).toBe(executeEmployeeRun);
    expect(resolveJobHandler('allrice.system.echo')).toBe(executeSystemEcho);
  });

  it.each(['allrice.unknown', 'allrice.workflow.run'])(
    'rejects %s without retry or falling back to a model',
    (type) => {
      expect(() => resolveJobHandler(type)).toThrowError(HandlerError);
      try {
        resolveJobHandler(type);
      } catch (error) {
        expect(error).toMatchObject({
          code: 'UNSUPPORTED_JOB_TYPE',
          retryable: false,
        });
      }
    },
  );
});
