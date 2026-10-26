import { describe, expect, it } from 'vitest';
import {
  changesetApproveLabel,
  changesetStatusLabel,
  changesetTitle,
  fileChangeLabel,
} from './changeset-presenter';

describe('file change wording for ordinary employees', () => {
  it('names run and file states without engineering terms', () => {
    for (const status of [
      'pending',
      'prepared',
      'applied',
      'conflict',
      'canceled',
      'failed',
      'unknown',
      'waiting_user',
      'ready',
      'dispatched',
      'running',
      'succeeded',
      'partial',
      'cancel_requested',
      'queued',
      'not_a_known_state',
    ])
      expect(changesetStatusLabel(status)).not.toMatch(
        /待核实|落盘|Bridge|回执|失败|[a-z]_[a-z]/,
      );
    expect(changesetStatusLabel('applied')).toBe('已保存到你的电脑');
    expect(changesetStatusLabel('ready')).toBe('等待电脑连接');
    expect(changesetStatusLabel('unknown')).toBe('结果待确认');
    expect(changesetStatusLabel('prepared')).toBe('结果待确认');
    expect(changesetStatusLabel('not_a_known_state')).toBe(
      '结果待确认，请刷新查看',
    );
  });

  it('names what is being allowed and what each file change does', () => {
    expect(changesetTitle(false, false)).toBe('保存修改');
    expect(changesetTitle(true, false)).toBe('恢复文件');
    expect(changesetTitle(false, true)).toBe('整理文件');
    expect(changesetApproveLabel(false, false)).toBe('允许保存这些修改');
    expect(changesetApproveLabel(true, true)).toBe('允许恢复这些文件');
    expect(changesetApproveLabel(false, true)).toBe('允许整理这些文件');
    expect(fileChangeLabel({ before: null, after: {} })).toBe('新建文件');
    expect(fileChangeLabel({ before: {}, after: null })).toBe('删除文件');
    expect(fileChangeLabel({ before: {}, after: {} })).toBe('修改文件');
  });
});
