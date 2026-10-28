import { expect, it } from 'vitest';
import type { z } from 'zod';
import { RepositoryReviewCommandSchema } from '@allrice/database/technical-contracts';
import { platformRepositoryReviewToolDefinition } from '../jobs/platform-repository-review.js';
import { selectDshNativeTools } from './dsh/native-tools.js';
import {
  dshInboundToolHandler,
  dshToolBridgeInstructions,
} from './dsh/tool-bridge.js';

const { reviewNativeInputSchema, technicalNativeTools } = (await import(
  new URL('../../dsh/allrice-technical-native-tools.mjs', import.meta.url).href
)) as {
  reviewNativeInputSchema: z.ZodType;
  technicalNativeTools: { canonicalName: string; description: string }[];
};

it('keeps the plain-Node native review validator in parity with the strict Broker DTO', () => {
  const candidate = {
    artifactId: '00000000-0000-4000-8000-000000000001',
    digest: `sha256:${'a'.repeat(64)}`,
  };
  const evidence = {
    kind: 'repository_ci',
    subjectId: candidate.artifactId,
    evidenceDigest: candidate.digest,
  };
  for (const valid of [
    { action: 'inspect' },
    { action: 'inspect', candidate },
    {
      action: 'review',
      candidate,
      evidence,
      verdict: 'accept',
      summary: ' Exact review ',
    },
    {
      action: 'review',
      candidate,
      evidence,
      verdict: 'revise',
      summary: 'Changes required',
    },
    { action: 'deliver', candidate, reviewId: candidate.artifactId },
  ]) {
    expect(reviewNativeInputSchema.parse(valid)).toEqual(
      RepositoryReviewCommandSchema.parse(valid),
    );
    for (const invalid of [
      { ...valid, ownerId: candidate.artifactId },
      { ...valid, candidate: { ...candidate, digest: 'bad' } },
      { ...valid, candidate: { ...candidate, ownerId: candidate.artifactId } },
      { ...valid, action: 'merge' },
    ]) {
      expect(reviewNativeInputSchema.safeParse(invalid).success).toBe(false);
      expect(RepositoryReviewCommandSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  }
  for (const invalid of [
    { action: 'review', candidate, evidence, verdict: 'accept', summary: ' ' },
    {
      action: 'review',
      candidate,
      evidence,
      verdict: 'accept',
      summary: 'x'.repeat(16001),
    },
    {
      action: 'review',
      candidate,
      verdict: 'accept',
      summary: 'Missing evidence',
    },
    { action: 'deliver', candidate },
  ]) {
    expect(reviewNativeInputSchema.safeParse(invalid).success).toBe(false);
    expect(RepositoryReviewCommandSchema.safeParse(invalid).success).toBe(
      false,
    );
  }
  expect(
    technicalNativeTools.find(
      (t) => t.canonicalName === platformRepositoryReviewToolDefinition.name,
    )?.description,
  ).toBe(platformRepositoryReviewToolDefinition.description);
});

it('selects the requested private review function and keeps its inbound authorization per Run', async () => {
  const native = await selectDshNativeTools(['platform.repository.review']);
  expect(native).toEqual(['platform.repository.review']);
  expect(await selectDshNativeTools([])).toEqual([]);
  const tools = [platformRepositoryReviewToolDefinition];
  const instructions = dshToolBridgeInstructions({ tools }, new Set(native));
  expect(instructions).not.toContain('<allrice_tool_call>');
  const params = {
    toolCallId: 'native-call',
    name: 'platform.repository.review',
    arguments: { action: 'inspect' },
  };
  await expect(
    dshInboundToolHandler({
      tools: [],
      onToolCall: async () => {
        throw Error('must not run');
      },
    })('allrice/tool-call', params),
  ).rejects.toMatchObject({ code: 'TOOL_NOT_ALLOWED' });
  let received = false;
  await expect(
    dshInboundToolHandler({
      tools,
      onToolCall: async (call) => {
        received = true;
        expect(call).toEqual({
          id: params.toolCallId,
          name: params.name,
          arguments: params.arguments,
        });
        return { modelContent: 'scoped business result', summary: 'review' };
      },
    })('allrice/tool-call', params),
  ).resolves.toMatchObject({ modelContent: 'scoped business result' });
  expect(received).toBe(true);
});
