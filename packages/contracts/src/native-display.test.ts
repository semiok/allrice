import { describe, expect, it } from 'vitest';
import { toolActivityDetail } from './native-display.js';
describe('public Python activity description', () => {
  it.each(['python.execute', 'python_execute'])(
    'only releases the known safe description for %s',
    (name) => {
      expect(
        toolActivityDetail(name, {
          description: '按月份汇总销售额与毛利率',
          code: 'secret_program()',
          token: 'secret',
        }),
      ).toBe('按月份汇总销售额与毛利率');
      expect(
        toolActivityDetail(name, { code: 'secret_program()' }),
      ).toBeUndefined();
      expect(
        toolActivityDetail(name, { description: '执行代码; secret_program()' }),
      ).toBeUndefined();
    },
  );
});
