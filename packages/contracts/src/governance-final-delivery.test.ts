import { describe, expect, it } from 'vitest';
import {
  modelGovernanceFailureText,
  nativeExecutionFailureText,
} from './governance.js';

describe('deterministic final delivery failure presentation', () => {
  it.each([
    'FINAL_DELIVERY_RESPONSE_INVALID',
    'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
  ])('shows %s alongside retained native reply and artifacts', (code) => {
    const text = nativeExecutionFailureText(code);
    expect(text).not.toContain('全部完成');
    expect(text).toContain('已保留');
    expect(text).toContain('没有自动重跑');
    expect(modelGovernanceFailureText(code)).toBe(text);
  });
  it('keeps the existing document failure copy', () => {
    expect(
      nativeExecutionFailureText('DOCUMENT_DELIVERY_INCOMPLETE'),
    ).toContain('历史版本不会冒充新文件');
  });
  it('keeps unknown errors unknown rather than claiming a delivery failure', () => {
    expect(nativeExecutionFailureText('UNKNOWN_ERROR')).toBeNull();
  });
});
