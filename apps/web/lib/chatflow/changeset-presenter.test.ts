import { describe, expect, it } from 'vitest';
import {
  changesetApproveLabel,
  changesetFileLabel,
  changesetFileNote,
  changesetTaskLabel,
  changesetTitle,
  fileChangeLabel,
} from './changeset-presenter';

const engineering =
  /待核实|核实|落盘|Bridge|回执|失败|[A-Z]+_[A-Z]+|[a-z]_[a-z]/;

describe('file change wording for ordinary employees', () => {
  it('names every task state, saying what a waiting task waits for', () => {
    // RunStatusSchema plus RuntimeOperationStatusSchema.
    for (const status of [
      'queued',
      'running',
      'waiting_approval',
      'succeeded',
      'failed',
      'canceled',
      'needs_attention',
      'planned',
      'waiting_user',
      'waiting_device',
      'waiting_dependency',
      'ready',
      'dispatched',
      'cancel_requested',
      'unknown',
      'partial',
    ]) {
      const label = changesetTaskLabel(status);
      expect(label).not.toMatch(engineering);
      if (/^(waiting|planned|ready|queued)/.test(status))
        expect(label).not.toContain('结果待确认');
    }
    expect(changesetTaskLabel('waiting_device')).toBe('等待电脑连接');
    expect(changesetTaskLabel('waiting_dependency')).toBe('等前面的步骤完成');
    expect(changesetTaskLabel('waiting_approval')).toBe('等你确认');
    expect(changesetTaskLabel('unknown')).toBe('结果待确认');
    expect(changesetTaskLabel('not_a_known_state')).toBe(
      '状态待确认，请刷新查看',
    );
  });

  it('names file results apart from task states', () => {
    for (const status of [
      'pending',
      'prepared',
      'applied',
      'conflict',
      'canceled',
      'failed',
      'unknown',
      'not_a_known_state',
    ])
      expect(changesetFileLabel(status)).not.toMatch(engineering);
    expect(changesetFileLabel('applied')).toBe('已保存到你的电脑');
    // A conflict is not always an edit by someone else.
    expect(changesetFileLabel('conflict')).toBe('没有改动');
    expect(changesetFileLabel('unknown')).toBe('结果待确认');
  });

  it('names a cause only for codes with a single cause', () => {
    // FileGuardian.swift: EEXIST at the destination.
    expect(changesetFileNote('conflict', 'FILE_DESTINATION_EXISTS')).toContain(
      '目标位置已经有同名的文件或文件夹',
    );
    // FileGuardian.swift: a path component is not a directory.
    const notFolder = changesetFileNote('conflict', 'FILE_DIRECTORY_REQUIRED');
    expect(notFolder).toContain('路径里有一段不是文件夹');
    expect(notFolder).not.toMatch(/移动|删除/);
    expect(changesetFileNote('conflict', 'FILE_ACCESS_DENIED')).toContain(
      '没有权限',
    );
    expect(changesetFileNote('canceled', 'AUTHORITY_LOST')).toContain(
      '没有改动',
    );
    // FileGuardian FILE_CHANGED also covers copy verification and hard
    // links; file-organization.ts raises it for any preflight mismatch.
    for (const code of ['FILE_CHANGED', 'FILE_PARENT_CHANGED', 'SOMETHING_NEW'])
      expect(changesetFileNote('conflict', code)).toBe(
        '保存前的检查没有通过，这个文件没有改动。请看一下文件现在的内容，再让 AI 员工重新安排。',
      );
    // An unconfirmed file always asks to check it, whatever the code.
    for (const status of ['unknown', 'prepared'])
      expect(changesetFileNote(status, 'FILE_DESTINATION_EXISTS')).toBe(
        '没有收到这个文件的处理结果，请打开文件确认有没有改动。',
      );
    expect(changesetFileNote('failed')).toContain('没有处理完');
    expect(changesetFileNote('applied')).toBeNull();
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
