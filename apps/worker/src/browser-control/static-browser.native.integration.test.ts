import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { staticBrowserImageV1 } from '@allrice/contracts';
import { CloudRunnerBackend } from '../cloud-runner/backend.js';

const suite =
  process.env.ALLRICE_RUN_CLOUD_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite('static browser in the dedicated gVisor VM', () => {
  const backend = new CloudRunnerBackend();
  const attempts: string[] = [];
  afterEach(async () => {
    for (const id of attempts.splice(0)) {
      await backend.stop(id);
      await backend.cleanup(id);
    }
  });

  function document(html: string) {
    const bytes = Buffer.from(html);
    return {
      target: {
        versionId: randomUUID(),
        checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        version: 1 as const,
        objectId: randomUUID(),
        sizeBytes: bytes.length,
        mediaType: 'text/html' as const,
        fileName: 'index.html',
        sourceOperationId: null,
        sourceSessionId: randomUUID(),
      },
      contentBase64: bytes.toString('base64'),
    };
  }
  async function verify(html: string, steps: unknown[]) {
    const id = randomUUID();
    attempts.push(id);
    return backend.executeStaticBrowser(
      document(html),
      { version: 1, timeoutMs: 30_000, steps } as never,
      {
        attemptId: id,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        maintainLease: async () => true,
      },
    );
  }

  it('renders saved CJK HTML, runs fixed steps and returns a 1280x720 screenshot', async () => {
    const result = await verify(
      '<!doctype html><meta charset="utf-8"><title>验收页</title><h1>你好 AllRice</h1>' +
        "<button onclick=\"document.querySelector('h1').textContent='已点击'\">确认</button>",
      [
        { type: 'title_equals', expected: '验收页' },
        { type: 'text_contains', expected: '你好 AllRice' },
        { type: 'click', selector: { tag: 'button', label: '确认' } },
        { type: 'text_contains', expected: '已点击' },
      ],
    );
    expect(result.reason).toBe('completed');
    expect(result.imageDigest).toBe(staticBrowserImageV1);
    expect(result.staticVerification?.report.verdict).toBe('passed');
    expect(result.staticVerification?.browserVersion).toMatch(/^\S+/);
    const png = Buffer.from(
      result.staticVerification!.screenshotBase64,
      'base64',
    );
    expect(png.readUInt32BE(16)).toBe(1280);
    expect(png.readUInt32BE(20)).toBe(720);
  }, 90_000);
});
