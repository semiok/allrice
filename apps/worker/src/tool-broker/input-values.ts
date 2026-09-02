import { HandlerError } from '../errors.js';

export function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HandlerError('TOOL_INPUT_INVALID', '工具参数格式不正确', false);
  }
  return value as Record<string, unknown>;
}

export function stringValue(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HandlerError('TOOL_INPUT_INVALID', `${name} 不能为空`, false);
  }
  return value.trim();
}

export function limitValue(value: unknown, fallback: number, maximum: number) {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(Math.max(value, 1), maximum)
    : fallback;
}

const memoryClasses = new Set([
  'user_preference',
  'project_fact',
  'decision',
  'work_note',
]);

export function memoryClassValue(value: unknown) {
  if (value === undefined) return 'work_note';
  if (typeof value !== 'string' || !memoryClasses.has(value)) {
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      'memoryClass 必须是 user_preference、project_fact、decision 或 work_note',
      false,
    );
  }
  return value as 'user_preference' | 'project_fact' | 'decision' | 'work_note';
}

export function memoryLifecycleStateValue(value: unknown) {
  if (value !== 'candidate' && value !== 'durable') {
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      'lifecycleState 必须是 candidate 或 durable',
      false,
    );
  }
  return value;
}
