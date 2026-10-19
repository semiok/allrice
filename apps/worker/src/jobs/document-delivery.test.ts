import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { documentDeliveryGuard } from './document-delivery.js';

const call = (format: string) => ({
  id: format,
  name: 'workspace.export.create',
  arguments: { format, fileName: `report.${format}` },
});
describe('document delivery outcome', () => {
  const parentObjectId: string = randomUUID();
  const revision = (format: string, content = '# Corrected result') => ({
    id: randomUUID(),
    name: 'workspace.export.create',
    arguments: {
      format,
      fileName: 'README-v2.md',
      content,
      parentObjectId,
    },
  });
  const receipt = (content = '# Corrected result', overrides = {}) => ({
    modelContent: JSON.stringify({
      objectId: randomUUID(),
      seriesId: randomUUID(),
      parentObjectId,
      digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      version: 2,
      ...overrides,
    }),
    summary: 'Published from the trusted Broker',
  });
  const failed = async () => {
    throw Error('parent format mismatch');
  };
  it('keeps a failed document revision incomplete even when a reply or another format succeeds', async () => {
    const guard = documentDeliveryGuard();
    await expect(
      guard.execute(call('xlsx'), async () => {
        throw Error('failed export');
      }),
    ).rejects.toThrow('failed export');
    await guard.execute(call('docx'), async () => ({ objectId: 'new-docx' }));
    expect(() => guard.assertComplete()).toThrow('xlsx');
  });
  it('allows the native model to correct its script and complete the delivery', async () => {
    const guard = documentDeliveryGuard();
    await expect(
      guard.execute(call('xlsx'), async () => {
        throw Error('bad script');
      }),
    ).rejects.toThrow();
    await guard.execute(call('xlsx'), async () => ({ objectId: 'new-xlsx' }));
    expect(() => guard.assertComplete()).not.toThrow();
  });
  it('does not mistake an ordinary failed read for a document delivery', async () => {
    const guard = documentDeliveryGuard();
    await expect(
      guard.execute(
        { ...call('xlsx'), name: 'workspace.document.read' },
        async () => {
          throw Error('read failure');
        },
      ),
    ).rejects.toThrow();
    expect(() => guard.assertComplete()).not.toThrow();
  });
  it('does not let another file of the same format disguise a missing revision', async () => {
    const guard = documentDeliveryGuard();
    await expect(
      guard.execute(call('xlsx'), async () => {
        throw Error('revision failed');
      }),
    ).rejects.toThrow();
    await guard.execute(
      {
        ...call('xlsx'),
        arguments: { format: 'xlsx', fileName: 'other.xlsx' },
      },
      async () => ({ objectId: 'other' }),
    );
    expect(() => guard.assertComplete()).toThrow('report.xlsx');
  });

  it('reconciles a wrong text format only after the exact bytes revise the same parent as Markdown', async () => {
    const guard = documentDeliveryGuard();
    await expect(guard.execute(revision('text'), failed)).rejects.toThrow();
    await guard.execute(revision('markdown'), async () => receipt());
    expect(() => guard.assertComplete()).not.toThrow();
  });

  it.each([
    { parentObjectId: randomUUID() },
    { parentObjectId: null, version: 1 },
    { digest: `sha256:${'a'.repeat(64)}` },
    { objectId: 'model-supplied-name' },
    { seriesId: null },
    { version: 1 },
  ])(
    'does not accept an unrelated or incomplete publication receipt: %j',
    async (overrides) => {
      const guard = documentDeliveryGuard();
      await expect(guard.execute(revision('text'), failed)).rejects.toThrow();
      await guard.execute(revision('markdown'), async () =>
        receipt(undefined, overrides),
      );
      expect(() => guard.assertComplete()).toThrow('README-v2.md (text)');
    },
  );

  it.each(['已生成文件', 'null', '{}'])(
    'does not reconcile using prose or malformed receipt %s',
    async (modelContent) => {
      const guard = documentDeliveryGuard();
      await expect(guard.execute(revision('text'), failed)).rejects.toThrow();
      await guard.execute(revision('markdown'), async () => ({ modelContent }));
      expect(() => guard.assertComplete()).toThrow('README-v2.md (text)');
    },
  );

  it('does not use a prior successful revision to cover new content that failed later', async () => {
    const guard = documentDeliveryGuard();
    await guard.execute(revision('markdown'), async () => receipt());
    await expect(
      guard.execute(
        revision('markdown', '# A different later revision'),
        failed,
      ),
    ).rejects.toThrow();
    expect(() => guard.assertComplete()).toThrow('README-v2.md (markdown)');
    // Replaying the old content is also rejected by the now-stale parent. Its
    // old exact receipt must not erase the different pending revision above.
    await expect(guard.execute(revision('markdown'), failed)).rejects.toThrow();
    expect(() => guard.assertComplete()).toThrow('README-v2.md (markdown)');
  });

  it('normalizes a valid UUID parent before matching a trusted receipt', async () => {
    const guard = documentDeliveryGuard();
    const original = revision('text');
    original.arguments.parentObjectId = parentObjectId.toUpperCase();
    await expect(guard.execute(original, failed)).rejects.toThrow();
    await guard.execute(revision('markdown'), async () => receipt());
    expect(() => guard.assertComplete()).not.toThrow();
  });

  it('does not let a late old success hide a newer failed revision', async () => {
    const guard = documentDeliveryGuard();
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const old = guard.execute(revision('markdown'), async () => {
      await wait;
      return receipt();
    });
    await expect(
      guard.execute(revision('markdown', 'New content'), failed),
    ).rejects.toThrow();
    finish();
    await old;
    expect(() => guard.assertComplete()).toThrow('README-v2.md (markdown)');
  });

  it('allows a newer successful correction even when the older failure arrives late', async () => {
    const guard = documentDeliveryGuard();
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const old = expect(
      guard.execute(revision('markdown'), async () => {
        await wait;
        throw Error('old failed attempt');
      }),
    ).rejects.toThrow('old failed attempt');
    await guard.execute(revision('markdown', 'Corrected content'), async () =>
      receipt('Corrected content'),
    );
    finish();
    await old;
    expect(() => guard.assertComplete()).not.toThrow();
  });

  it('does not confuse same-name revisions of different parents or a new series', async () => {
    const guard = documentDeliveryGuard();
    await expect(guard.execute(revision('markdown'), failed)).rejects.toThrow();
    const other = revision('markdown');
    other.arguments.parentObjectId = randomUUID();
    await guard.execute(other, async () =>
      receipt(undefined, { parentObjectId: other.arguments.parentObjectId }),
    );
    await guard.execute(
      {
        ...other,
        arguments: {
          format: 'markdown',
          fileName: 'README-v2.md',
          content: '# Corrected result',
        },
      },
      async () => receipt(undefined, { parentObjectId: null, version: 1 }),
    );
    expect(() => guard.assertComplete()).toThrow('README-v2.md (markdown)');
  });

  it('requires the same requested file name and content to reconcile formats', async () => {
    const guard = documentDeliveryGuard();
    await expect(guard.execute(revision('text'), failed)).rejects.toThrow();
    const other = revision('markdown');
    other.arguments.fileName = 'unrelated.md';
    await guard.execute(other, async () => receipt());
    await guard.execute(revision('html', 'Different content'), async () =>
      receipt('Different content'),
    );
    expect(() => guard.assertComplete()).toThrow('README-v2.md (text)');
  });

  it('does not treat an Office script failure as a completed plain-text revision', async () => {
    const guard = documentDeliveryGuard();
    await expect(
      guard.execute(
        {
          ...revision('xlsx'),
          arguments: {
            fileName: 'README-v2.md',
            parentObjectId,
            format: 'xlsx',
            python: { script: 'failed' },
          },
        },
        failed,
      ),
    ).rejects.toThrow();
    await guard.execute(revision('markdown'), async () => receipt());
    expect(() => guard.assertComplete()).toThrow('xlsx');
  });

  it('keeps a required HTML original-series revision incomplete until its actual receipt arrives', async () => {
    const guard = documentDeliveryGuard();
    const html = (format: string) => ({
      ...revision(format, '<h1>72 rows / 1137537 cents</h1>'),
      arguments: {
        ...revision(format, '<h1>72 rows / 1137537 cents</h1>').arguments,
        fileName: 'ledger-tool.html',
      },
    });
    // The actual failed Run had a successful project HTML in a new series.
    await guard.execute(
      { ...html('html'), name: 'workspace.project.execute' },
      async () =>
        receipt(html('html').arguments.content, {
          parentObjectId: null,
          version: 1,
        }),
    );
    await expect(guard.execute(html('html'), failed)).rejects.toThrow();
    await expect(guard.execute(revision('text'), failed)).rejects.toThrow();
    await guard.execute(revision('markdown'), async () => receipt());
    await expect(guard.execute(html('text'), failed)).rejects.toThrow();
    expect(() => guard.assertComplete()).toThrow(
      'ledger-tool.html (html)、ledger-tool.html (text)',
    );
    await guard.execute(html('html'), async () =>
      receipt(html('html').arguments.content),
    );
    expect(() => guard.assertComplete()).not.toThrow();
    // A late, redundant wrong-format attempt cannot invalidate exact bytes
    // already persisted into that parent during this Run.
    await expect(guard.execute(html('text'), failed)).rejects.toThrow();
    expect(() => guard.assertComplete()).not.toThrow();
  });
});
