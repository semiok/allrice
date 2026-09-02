import { describe, expect, it } from 'vitest';

import {
  limitValue,
  memoryClassValue,
  memoryLifecycleStateValue,
  objectValue,
  stringValue,
} from './input-values.js';

describe('Tool Broker input values', () => {
  it('accepts object arguments and rejects non-object values', () => {
    const value = { query: 'rice' };
    expect(objectValue(value)).toBe(value);
    for (const invalid of [null, undefined, [], 'query', 1]) {
      expect(() => objectValue(invalid)).toThrowError(
        expect.objectContaining({ code: 'TOOL_INPUT_INVALID' }),
      );
    }
  });

  it('trims required strings and rejects blank values', () => {
    expect(stringValue('  Rice  ', 'name')).toBe('Rice');
    expect(() => stringValue('   ', 'name')).toThrowError(
      expect.objectContaining({ code: 'TOOL_INPUT_INVALID' }),
    );
  });

  it('uses the fallback for non-integers and clamps integers', () => {
    expect(limitValue(undefined, 5, 10)).toBe(5);
    expect(limitValue(2.5, 5, 10)).toBe(5);
    expect(limitValue(0, 5, 10)).toBe(1);
    expect(limitValue(20, 5, 10)).toBe(10);
    expect(limitValue(7, 5, 10)).toBe(7);
  });

  it('keeps the memory class and lifecycle allowlists stable', () => {
    expect(memoryClassValue(undefined)).toBe('work_note');
    expect(memoryClassValue('decision')).toBe('decision');
    expect(memoryLifecycleStateValue('candidate')).toBe('candidate');
    expect(memoryLifecycleStateValue('durable')).toBe('durable');
    expect(() => memoryClassValue('inference')).toThrowError(
      expect.objectContaining({ code: 'TOOL_INPUT_INVALID' }),
    );
    expect(() => memoryLifecycleStateValue('archived')).toThrowError(
      expect.objectContaining({ code: 'TOOL_INPUT_INVALID' }),
    );
  });
});
