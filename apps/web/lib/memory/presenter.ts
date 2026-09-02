import type {
  MemoryClass,
  MemoryLifecycleState,
  MemorySourceType,
  MemoryTrust,
} from '@allrice/contracts';

export type { MemoryClass, MemoryLifecycleState, MemoryTrust };

export interface PresentableMemory {
  lifecycleState?: MemoryLifecycleState;
  trust: MemoryTrust;
  sourceType: MemorySourceType;
}

export function resolveMemoryLifecycle(
  memory: PresentableMemory,
): MemoryLifecycleState {
  if (memory.lifecycleState) return memory.lifecycleState;
  return memory.trust === 'user_confirmed' ||
    memory.trust === 'platform_verified'
    ? 'durable'
    : 'candidate';
}

export function memoryLifecycleLabel(memory: PresentableMemory) {
  return resolveMemoryLifecycle(memory) === 'durable' ? '长期记忆' : '待你确认';
}

export function memorySourceLabel(memory: PresentableMemory) {
  switch (memory.sourceType) {
    case 'user':
      return '你直接保存';
    case 'message':
      return '来自对话';
    case 'file':
      return '来自文件';
    case 'tool':
      return '来自工具结果';
    case 'connector':
      return '来自外部连接';
    case 'checkpoint':
      return '来自上下文压缩';
  }
}

export function memoryClassLabel(memoryClass?: MemoryClass) {
  if (!memoryClass) return '工作记录';
  switch (memoryClass) {
    case 'user_preference':
      return '用户偏好';
    case 'project_fact':
      return '项目事实';
    case 'decision':
      return '关键决策';
    case 'work_note':
      return '工作记录';
  }
}
