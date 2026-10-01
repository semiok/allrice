import { describe, expect, it } from 'vitest';
import { documentDeliveryGuard } from './document-delivery.js';

const call = (format: string) => ({
  id: format,
  name: 'workspace.export.create',
  arguments: { format },
});
describe('document delivery outcome', () => {
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
});
