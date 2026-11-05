import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EmployeeDocumentsSchema, employeeDocumentDigestPlaceholder as digest,
  selectEmployeeDocumentMemories, renderEmployeeMemoryDocument,
  selectEmployeeUserFacts, renderEmployeeUserDocument } from './employee-documents.ts';

describe('bounded employee document views', () => {
  it('keeps complete conditions, includes envelopes and handles in UTF-8 limits and counts omissions', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ id: randomUUID(), revision: 1,
      content: i === 0 ? '超长'.repeat(3000) : `第${i}条：仅已确认的12笔；不得合并退款。`,
      sourceHandle: `experience:${digest}` }));
    const selected = selectEmployeeDocumentMemories([...items, items[1]!], items.length);
    expect(selected).toHaveLength(20);
    expect(selected).not.toContain(items[0]);
    expect(new Set(selected.map((item) => item.id)).size).toBe(20);
    const memory = renderEmployeeMemoryDocument(selected, items.length, digest);
    expect(Buffer.byteLength(memory)).toBeLessThanOrEqual(6000);
    expect(memory).toContain('"omittedCount":5');
    for (const item of selected) expect(memory).toContain(item.content);
    expect(EmployeeDocumentsSchema.parse({ user: '', memory }).memory).toBe(memory);
    expect(renderEmployeeMemoryDocument([], 0, digest)).toBe('');
  });
  it('omits whole oversized USER fields and does not synthesize missing department or authority', () => {
    const selected = selectEmployeeUserFacts({ companyName: '公司', displayName: '真人',
      responsibilities: '不得越权'.repeat(2000), businessContext: '{{secret}}' });
    expect(selected.omitted).toEqual(['responsibilities']);
    expect(selected.facts).not.toHaveProperty('departmentName');
    const user = renderEmployeeUserDocument(selected.facts, selected.omitted, digest);
    expect(user).toContain('{{secret}}');
    expect(Buffer.byteLength(user)).toBeLessThanOrEqual(2048);
    expect(renderEmployeeUserDocument({}, [], digest)).toBe('');
    expect(EmployeeDocumentsSchema.safeParse({ user: '汉'.repeat(1000), memory: '' }).success).toBe(false);
  });
});
