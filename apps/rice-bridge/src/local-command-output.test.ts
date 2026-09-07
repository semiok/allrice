import { describe, expect, it } from 'vitest';
import { LocalCommandOutputFilter } from './local-command-output.js';
describe('local command output disclosure boundary', () => {
  it('preserves UTF-8 split across transport frames', () => {
    const f = new LocalCommandOutputFilter(),
      bytes = Buffer.from('中文\n');
    expect(f.push(bytes.subarray(0, 1))).toBe('');
    expect(f.push(bytes.subarray(1))).toBe('中文\n');
  });
  it('redacts credential values even when their prefix crosses chunks', () => {
    const f = new LocalCommandOutputFilter();
    expect(f.push(Buffer.from('api_'))).toBe('');
    expect(f.push(Buffer.from('key=synthetic-do-not-publish\n'))).toBe(
      'api_key=[REDACTED]\n',
    );
    expect(
      f.push(Buffer.from('Authorization: Bearer synthetic-test-token\n')),
    ).not.toContain('synthetic-test-token');
  });
  it('does not flush an overlong incomplete line or a multiline private key', () => {
    const f = new LocalCommandOutputFilter();
    expect(f.push(Buffer.from('x'.repeat(5000)))).toContain('已省略');
    expect(f.push(Buffer.from('hidden-tail\n'))).toBe('');
    expect(f.truncated).toBe(true);
    const key = f.push(
      Buffer.from(
        '-----BEGIN PRIVATE KEY-----\nsynthetic-material\n-----END PRIVATE KEY-----\n',
      ),
    );
    expect(key).not.toContain('synthetic-material');
    expect(f.push(Buffer.from('visible'), true)).toBe('visible');
  });
});
