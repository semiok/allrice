import { describe, expect, it } from 'vitest';
import { availableWorkbenchFileName } from './workbench-file-name.ts';

describe('new personal publication names', () => {
  it('keeps exact free names, finds the first suffix and preserves the actual extension', () => {
    const occupied = new Set(['月报.docx', '月报（2）.docx', '月报（4）.docx']);
    expect(availableWorkbenchFileName('月报.docx', occupied)).toBe(
      '月报（3）.docx',
    );
    expect(availableWorkbenchFileName('月报.PDF', occupied)).toBe('月报.PDF');
    expect(
      availableWorkbenchFileName('归档.tar.gz', new Set(['归档.tar.gz'])),
    ).toBe('归档.tar（2）.gz');
    expect(availableWorkbenchFileName('无扩展名', new Set(['无扩展名']))).toBe(
      '无扩展名（2）',
    );
    expect(availableWorkbenchFileName('.env', new Set(['.env']))).toBe(
      '.env（2）',
    );
  });
  it('treats Unicode, case and literal suffixes as exact original names', () => {
    expect(
      availableWorkbenchFileName('Report.txt', new Set(['report.txt'])),
    ).toBe('Report.txt');
    expect(availableWorkbenchFileName('e\u0301.txt', new Set(['é.txt']))).toBe(
      'e\u0301.txt',
    );
    expect(
      availableWorkbenchFileName('报告（2）.txt', new Set(['报告（2）.txt'])),
    ).toBe('报告（2）（2）.txt');
  });
  it('fits the existing 255 UTF-16 limit without cutting a surrogate or the extension', () => {
    const name = '😀'.repeat(125) + '.docx';
    const final = availableWorkbenchFileName(name, new Set([name]));
    expect(final).toBe('😀'.repeat(123) + '（2）.docx');
    expect(final.length).toBe(254);
    const long = 'a'.repeat(251) + '.png';
    expect(availableWorkbenchFileName(long, new Set([long]))).toBe(
      'a'.repeat(248) + '（2）.png',
    );
    const extension = 'a.' + 'x'.repeat(253),
      second = 'a.' + 'x'.repeat(250) + '（2）',
      third = 'a.' + 'x'.repeat(250) + '（3）';
    expect(availableWorkbenchFileName(extension, new Set([extension]))).toBe(
      second,
    );
    expect(
      availableWorkbenchFileName(extension, new Set([extension, second])),
    ).toBe(third);
    expect(second.length).toBe(255);
    expect(third.length).toBe(255);
  });
});
