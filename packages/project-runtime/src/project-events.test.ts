import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { ProjectEvents } from './project-events.js';
const outputs = [
  { path: 'dist/index.html', fileName: 'index.html', format: 'html' as const },
];
function frame(bytes = Buffer.from('<html>成果</html>')) {
  return {
    type: 'artifact',
    path: outputs[0]!.path,
    data: bytes.toString('base64'),
    sizeBytes: bytes.length,
    checksum: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
  };
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
it('keeps fragmented verified artifact bytes separate from untrusted tenant stdout', () => {
  const events = new ProjectEvents(4096, undefined, outputs),
    artifact = frame();
  events.push(
    encode({ type: 'stdout', data: encode(artifact).toString('base64') }),
  );
  const encoded = encode(artifact);
  events.push(encoded.subarray(0, 21));
  events.push(encoded.subarray(21));
  events.push(
    encode({
      type: 'exit',
      reason: 'exited',
      code: 0,
      installation: 'succeeded',
    }),
  );
  const result = events.finish();
  expect(result.stdout).toContain('artifact');
  expect(result.artifacts).toEqual([
    {
      path: artifact.path,
      contentBase64: artifact.data,
      checksum: artifact.checksum,
      sizeBytes: artifact.sizeBytes,
    },
  ]);
});
it.each([
  { path: 'undeclared.txt' },
  { sizeBytes: 100_001 },
  { sizeBytes: 1 },
  { checksum: 'sha256:' + '0'.repeat(64) },
  { data: '!!!!' },
])('rejects unrequested, unbounded or changed artifact proof %j', (changed) => {
  const events = new ProjectEvents(4096, undefined, outputs);
  expect(() => events.push(encode({ ...frame(), ...changed }))).toThrow();
});
it('rejects duplicate output and records after terminal evidence', () => {
  const events = new ProjectEvents(4096, undefined, outputs);
  events.push(encode(frame()));
  expect(() => events.push(encode(frame()))).toThrow();
  const ended = new ProjectEvents(4096, undefined, outputs);
  ended.push(
    encode({
      type: 'exit',
      reason: 'exited',
      code: 0,
      installation: 'succeeded',
    }),
  );
  expect(() => ended.push(encode(frame()))).toThrow();
});
