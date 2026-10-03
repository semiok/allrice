import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runDocumentDerivation } from './document-derivation-runner.ts';

const ports = vi.hoisted(() => ({ path: '', guardian: vi.fn() }));
vi.mock('./config.js', () => ({
  configPath: () => join(ports.path, 'config.json'),
}));
vi.mock('./local-pdf-resources.js', () => ({
  inspectFixedPdfResources: () => ({}),
}));
vi.mock('./local-pdf-runner.js', () => ({ runPdfGuardian: ports.guardian }));
afterEach(async () => {
  if (ports.path) await rm(ports.path, { recursive: true, force: true });
  ports.path = '';
  ports.guardian.mockReset();
});
it.each(['truncated guardian receipt', 'missing physical stop'] as const)(
  'preserves unknown execution for %s without uploading or claiming a stopped child',
  async (reason) => {
    ports.path = await mkdtemp(join(tmpdir(), 'allrice-transform-supervisor-'));
    if (reason === 'truncated guardian receipt')
      ports.guardian.mockRejectedValue(Error('PDF_RESULT_UNKNOWN'));
    else ports.guardian.mockResolvedValue({ stopped: false });
    await expect(
      runDocumentDerivation(
        [{ path: 'source.pdf', bytes: Buffer.from('synthetic') }],
        { kind: 'pdf_extract', pages: [1], fileName: 'out.pdf' },
        { signal: new AbortController().signal, authorize: async () => true },
      ),
    ).rejects.toMatchObject({
      code: 'DOCUMENT_TRANSFORM_PROCESS_UNKNOWN',
      unknown: true,
    });
  },
);
it('does not spawn the fixed child when authority is already revoked', async () => {
  ports.path = await mkdtemp(join(tmpdir(), 'allrice-transform-authority-'));
  await expect(
    runDocumentDerivation(
      [],
      { kind: 'pdf_merge', fileName: 'out.pdf' },
      { signal: new AbortController().signal, authorize: async () => false },
    ),
  ).rejects.toThrow('AUTHORITY_LOST');
  expect(ports.guardian).not.toHaveBeenCalled();
});
