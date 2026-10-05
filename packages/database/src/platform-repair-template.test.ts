import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repairTemplateSlot } from './platform-repair-template.ts';
const before = readFileSync(
  new URL('../../project-runtime/src/command-output.ts', import.meta.url),
  'utf8',
);
const start = before.lastIndexOf('      .replace('),
  end = before.indexOf('      );', start) + '      );'.length;
const proposed = (slot: string) =>
  before.slice(0, start) + slot + before.slice(end);
describe('fixed immutable module template with a data-only regexp repair slot', () => {
  it('permits a bounded regexp and literal replacement with unchanged trusted code', () => {
    const candidate = proposed(
      "      .replace(\n        /((?:password|secret)[\\\"']?\\s*[:=]\\s*)(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|[^\\s,\"'}]+)/gi,\n        '$1[REDACTED]',\n      );",
    );
    expect(repairTemplateSlot(before, candidate).replacement).toBe(
      '$1[REDACTED]',
    );
  });
  it('rejects top-level spoofing, changed methods, callback code, statement injection and missing masks', () => {
    for (const candidate of [
      'process.stdout.write("spoof");process.exit(0);\n' + before,
      before.replace('private pending', 'public pending'),
      proposed('      .replace(/x/gi,()=>process.exit(0));'),
      proposed("      .replace(/x/gi,'[REDACTED]');process.exit(0);"),
      proposed("      .replace(/x/gi,'raw');"),
      proposed("      .replace(/x/gg,'[REDACTED]');"),
      proposed("      .replace(/x/gi,'[REDACTED]'+process.env.HOME);"),
      proposed("      .replace(/(/gi,'[REDACTED]');"),
    ])
      expect(() => repairTemplateSlot(before, candidate)).toThrow();
  });
});
