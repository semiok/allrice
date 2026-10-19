import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { HandlerError } from '../errors.js';
import {
  assertFinalDelivery,
  type FinalDeliveryCandidate,
  type FinalDeliveryPort,
} from './guard.js';
import type { DeliveryDecision } from './policy.js';

const candidate: FinalDeliveryCandidate = Object.freeze({
  nativeText:
    '[file](sandbox:/api/v1/files/00000000-0000-4000-8000-000000000001)',
  projectedText: '[file](/api/v1/files/00000000-0000-4000-8000-000000000001)',
  nativeSessionId: 'dsh-synthetic-root',
  observedReplyId: 'native-reply-1',
  attempt: 1,
  generation: 3,
});
const digest = (text: string) =>
  'sha256:' + createHash('sha256').update(text).digest('hex');
function decision(change: Partial<DeliveryDecision> = {}): DeliveryDecision {
  return {
    status: 'valid',
    candidateDigest: digest(candidate.projectedText),
    factSetDigest: 'sha256:' + 'a'.repeat(64),
    issues: [],
    linked: [],
    textRepairEligible: false,
    ...change,
  };
}
const invalid = (): DeliveryDecision =>
  decision({
    status: 'invalid_response',
    issues: [{ code: 'invalid_delivery_link', reason: 'object_id_required' }],
    textRepairEligible: true,
  });

describe('pre-finish deterministic delivery guard', () => {
  it('preserves an existing definitive delivery or budget stop', async () => {
    const error = new HandlerError(
      'DOCUMENT_DELIVERY_INCOMPLETE',
      'known delivery failure',
      false,
    );
    const port: FinalDeliveryPort = {
      check: async () => {
        throw error;
      },
    };
    await expect(
      assertFinalDelivery({
        port,
        candidate,
        signal: new AbortController().signal,
        report: async () => {},
      }),
    ).rejects.toBe(error);
  });

  it('does not let a retryable evidence-read error replay the model task', async () => {
    const port: FinalDeliveryPort = {
      check: async () => {
        throw new HandlerError('DATABASE_TRANSIENT', 'read retry', true);
      },
    };
    await expect(
      assertFinalDelivery({
        port,
        candidate,
        signal: new AbortController().signal,
        report: async () => {},
      }),
    ).rejects.toMatchObject({
      code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
      retryable: false,
    });
  });
  it('reports a valid decision bound to both native and projected candidates', async () => {
    const report = vi.fn(async () => {});
    const port = { check: vi.fn(async () => decision()) };
    await assertFinalDelivery({
      port,
      candidate,
      signal: new AbortController().signal,
      report,
    });
    expect(port.check).toHaveBeenCalledExactlyOnceWith(candidate);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        status: 'valid',
        candidateDigest: digest(candidate.projectedText),
        nativeCandidateDigest: digest(candidate.nativeText),
        nativeSessionId: candidate.nativeSessionId,
        observedReplyId: candidate.observedReplyId,
        attempt: 1,
        generation: 3,
      }),
    );
  });

  it('keeps invalid public/native candidates and throws a nonretryable failure before finish', async () => {
    const report = vi.fn(async () => {});
    const finish = vi.fn(async () => {});
    const port = { check: vi.fn(async () => invalid()) };
    const execute = async () => {
      await assertFinalDelivery({
        port,
        candidate,
        signal: new AbortController().signal,
        report,
      });
      await finish();
    };
    let caught: unknown;
    try {
      await execute();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HandlerError);
    expect(caught).toMatchObject({
      code: 'FINAL_DELIVERY_RESPONSE_INVALID',
      retryable: false,
    });
    expect(report).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();
    expect(candidate.nativeText).toContain('sandbox:');
    expect(candidate.projectedText).not.toContain('sandbox:');
  });

  it('distinguishes incomplete evidence from an actually invalid response', async () => {
    const port = {
      check: async () =>
        decision({
          status: 'evidence_unavailable',
          issues: [
            {
              code: 'delivery_evidence_incomplete',
              reason: 'snapshot_incomplete',
            },
          ],
        }),
    };
    await expect(
      assertFinalDelivery({
        port,
        candidate,
        signal: new AbortController().signal,
        report: async () => {},
      }),
    ).rejects.toMatchObject({
      code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
      retryable: false,
    });
  });

  it('does not expose a raw DB or provider error or silently permit query failure', async () => {
    const port: FinalDeliveryPort = {
      check: async () => {
        throw Error('private details');
      },
    };
    const report = vi.fn(async () => {});
    await expect(
      assertFinalDelivery({
        port,
        candidate,
        signal: new AbortController().signal,
        report,
      }),
    ).rejects.toMatchObject({
      code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
      retryable: false,
    });
    expect(report).not.toHaveBeenCalled();
  });

  it.each([
    { candidateDigest: 'sha256:' + 'b'.repeat(64) },
    { factSetDigest: 'not-a-digest' },
    { issues: [{ code: 'invalid_delivery_link' as const, reason: 'bad' }] },
  ])('rejects a stale or inconsistent success decision %j', async (change) => {
    const port = { check: async () => decision(change) };
    await expect(
      assertFinalDelivery({
        port,
        candidate,
        signal: new AbortController().signal,
        report: async () => {},
      }),
    ).rejects.toMatchObject({
      code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
      retryable: false,
    });
  });

  it('keeps cancellation before the read and makes no evidence call', async () => {
    const controller = new AbortController();
    const reason = Error('cancelled');
    controller.abort(reason);
    const port = { check: vi.fn(async () => decision()) };
    await expect(
      assertFinalDelivery({
        port,
        candidate,
        signal: controller.signal,
        report: async () => {},
      }),
    ).rejects.toBe(reason);
    expect(port.check).not.toHaveBeenCalled();
  });

  it('keeps cancellation during a successful read and does not complete or report success', async () => {
    const controller = new AbortController();
    const reason = Error('cancelled');
    const port = {
      check: async () => {
        controller.abort(reason);
        return decision();
      },
    };
    const report = vi.fn(async () => {});
    await expect(
      assertFinalDelivery({
        port,
        candidate,
        signal: controller.signal,
        report,
      }),
    ).rejects.toBe(reason);
    expect(report).not.toHaveBeenCalled();
  });

  it('keeps cancellation during a failed read rather than replacing it with a policy error', async () => {
    const controller = new AbortController();
    const reason = Error('cancelled');
    const port: FinalDeliveryPort = {
      check: async () => {
        controller.abort(reason);
        throw reason;
      },
    };
    await expect(
      assertFinalDelivery({
        port,
        candidate,
        signal: controller.signal,
        report: async () => {},
      }),
    ).rejects.toBe(reason);
  });

  it('fails nonretryably if durable report persistence is unknown', async () => {
    const error = Error('report persistence unknown');
    const port = { check: async () => decision() };
    await expect(
      assertFinalDelivery({
        port,
        candidate,
        signal: new AbortController().signal,
        report: async () => {
          throw error;
        },
      }),
    ).rejects.toMatchObject({
      code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
      retryable: false,
    });
  });

  it('does not finish when cancellation lands during persistence of a valid decision', async () => {
    const controller = new AbortController();
    const reason = Error('cancelled');
    const port = { check: async () => decision() };
    await expect(
      assertFinalDelivery({
        port,
        candidate,
        signal: controller.signal,
        report: async () => {
          controller.abort(reason);
        },
      }),
    ).rejects.toBe(reason);
  });
});
