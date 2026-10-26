import { expect, it, vi } from 'vitest';
import { fixture, ARTIFACT_ID } from './adapter-fixture.mjs';
import { getCheckedFinalDelivery } from '../../src/final-delivery/checked-delivery.ts';
import { DshRuntimePool } from '../../src/harness/dsh/runtime-pool.ts';
it('same-authority cold adapter reconciles a durable final reply with no runOnce/prompt and remints a private proof', async () => {
  const h = await fixture({ cold: true, priorRoot: true }),
    result = await h.adapter.execute(h.input),
    proof = getCheckedFinalDelivery(result);
  expect(h.run).not.toHaveBeenCalled();
  expect(h.client.recover).toHaveBeenCalledOnce();
  expect(h.bound.readFinalDeliveryReplyOrigin).toHaveBeenCalledOnce();
  expect(
    h.calls.filter((c) => c.action === 'joinForFinalDelivery'),
  ).toHaveLength(1);
  expect(result.answer).toBe(h.nativeText);
  expect(result.turnId).toBe('dsh-activation-root:turn:1');
  expect(proof).toEqual(h.finished[0]);
  expect(h.finish).toHaveBeenCalledOnce();
  expect(JSON.stringify([result, h.events, h.notices])).not.toContain(
    proof.nativeBindingId,
  );
});
it('covered cold missing origin fails without falling back to a model prompt or legacy finish', async () => {
  const h = await fixture({ cold: true, priorRoot: true, missingOrigin: true });
  await expect(h.adapter.execute(h.input)).rejects.toMatchObject({
    code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
    retryable: false,
  });
  expect(h.run).not.toHaveBeenCalled();
  expect(h.finish).not.toHaveBeenCalled();
});
it('explicit legacy cold path preserves the original continuation and does not require origin/proof', async () => {
  const h = await fixture({ cold: true, priorRoot: true, mode: 'legacy' }),
    result = await h.adapter.execute(h.input);
  expect(h.client.recover).toHaveBeenCalledOnce();
  expect(h.run).toHaveBeenCalledOnce();
  expect(h.bound.readFinalDeliveryReplyOrigin).not.toHaveBeenCalled();
  expect(h.calls.some((c) => c.action === 'join')).toBe(true);
  expect(h.calls.some((c) => c.action === 'joinForFinalDelivery')).toBe(false);
  expect(h.finished).toEqual([undefined]);
  expect(getCheckedFinalDelivery(result)).toBeUndefined();
});
it('a later new Run on existing native history still uses its genuine new turn instead of recovering the old final', async () => {
  const h = await fixture({ cold: true, priorRoot: false }),
    result = await h.adapter.execute(h.input);
  expect(h.run).toHaveBeenCalledOnce();
  expect(h.bound.readFinalDeliveryReplyOrigin).not.toHaveBeenCalled();
  expect(result.answer).toBe(h.nativeText);
  expect(getCheckedFinalDelivery(result)).toBeDefined();
});
it('covered hot execution keeps ordinary native continuation, never reads an old origin', async () => {
  const h = await fixture({ priorRoot: true }),
    result = await h.adapter.execute(h.input);
  expect(h.run).toHaveBeenCalledOnce();
  expect(h.bound.readFinalDeliveryReplyOrigin).not.toHaveBeenCalled();
  expect(getCheckedFinalDelivery(result)).toBeDefined();
});
it('no-assistant ordinary path has no new proof requirement', async () => {
  const h = await fixture({ noAssistant: true }),
    result = await h.adapter.execute(h.input);
  expect(h.run).toHaveBeenCalledOnce();
  expect(h.calls).toEqual([]);
  expect(getCheckedFinalDelivery(result)).toBeUndefined();
});
it('covered path with a missing final facts port never silently takes legacy', async () => {
  const h = await fixture({ missingPort: true });
  await expect(h.adapter.execute(h.input)).rejects.toMatchObject({
    code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
    retryable: false,
  });
  expect(h.finish).not.toHaveBeenCalled();
});
it('private origin bridge ignores caller-provided JSON and validates exact current root/native identity', async () => {
  const h = await fixture();
  await h.adapter.execute(h.input);
  // Execute cleanup removed the handler; capture the exact installed closure.
  const handler = h.client.setRequestHandler.mock.calls.find(([fn]) => fn)?.[0];
  await expect(
    handler('allrice/assistant/final-delivery-origin', {
      nativeSessionId: 'foreign',
      rootRunId: h.input.assistants.rootRunId,
      origin: { schemaVersion: 1 },
    }),
  ).rejects.toMatchObject({ code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE' });
  expect(h.bound.readFinalDeliveryReplyOrigin).not.toHaveBeenCalled();
});
// MET-221: checked delivery is this release's protocol on the restricted
// profile. The artifact frozen on the Run and the pin's first writer are
// provenance; the retired allowlist is ignored.
it.each(['frozen-id', 'pin-artifact', 'retired-allowlist'])(
  'checked cold execution of a same-generation context is not bound to an artifact ID: %s',
  async (kind) => {
    const h = await fixture({ cold: true, priorRoot: true }),
      earlier = 'sha256:' + 'b'.repeat(64);
    if (kind === 'frozen-id') h.input.assistants.deliveryArtifactId = earlier;
    if (kind === 'pin-artifact')
      Object.assign(h.pin, {
        artifactId: earlier,
        artifactManifestDigest: earlier,
      });
    if (kind === 'retired-allowlist')
      vi.stubEnv('ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS', '[]');
    const result = await h.adapter.execute(h.input),
      proof = getCheckedFinalDelivery(result);
    expect(h.run).not.toHaveBeenCalled();
    expect(h.client.recover).toHaveBeenCalledOnce();
    expect(h.bound.readFinalDeliveryReplyOrigin).toHaveBeenCalledOnce();
    expect(result.answer).toBe(h.nativeText);
    expect(proof).toEqual(h.finished[0]);
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.descriptor.artifactId).toBe(ARTIFACT_ID);
  },
);
it.each(['profile', 'no-descriptor'])(
  'checked cold execution refuses an incompatible measured artifact before runtime acquisition: %s',
  async (kind) => {
    const h = await fixture({ cold: true, priorRoot: true });
    if (kind === 'profile') h.descriptor.profileId = 'technical';
    if (kind === 'no-descriptor')
      vi.spyOn(
        DshRuntimePool.prototype,
        'describeNativeSession',
      ).mockReturnValue(null);
    await expect(h.adapter.execute(h.input)).rejects.toMatchObject({
      code: 'FINAL_DELIVERY_ARTIFACT_MISMATCH',
      retryable: false,
    });
    expect(h.client.recover).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.bound.readFinalDeliveryReplyOrigin).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.pin.artifactId).toBe(ARTIFACT_ID);
  },
);
it('checked cold execution still refuses a pin of another generation before runtime acquisition', async () => {
  const h = await fixture({ cold: true, priorRoot: true });
  h.pin.distributionGeneration = 'dsh-0.3.0-synthetic';
  await expect(h.adapter.execute(h.input)).rejects.toMatchObject({
    code: 'DSH_NATIVE_SESSION_BINDING_CONFLICT',
    retryable: false,
  });
  expect(h.client.recover).not.toHaveBeenCalled();
  expect(h.run).not.toHaveBeenCalled();
  expect(h.finish).not.toHaveBeenCalled();
});
