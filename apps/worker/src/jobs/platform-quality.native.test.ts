import { expect, it } from 'vitest';
import { ProjectWorkspaceToolInputSchema } from '@allrice/contracts';
import { qualityFixture, qualityAssertion } from '@allrice/database';
import {
  BrowserWorkspaceToolInputSchema,
  PrivateQualityLiveInputSchema,
} from '../browser-control/tool-input.js';
import { runQualityLiveVerification } from '../browser-control/quality-live-verify.js';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';
import { nativeBrokerRoundtrip } from '../harness/dsh-native-broker.fixture.js';
it('the fixed Chinese fixture reaches the pinned native project schema without backend or authority fields', async () => {
  const args = { action: 'open', files: qualityFixture('defect').files };
  await nativeBrokerRoundtrip({
    canonicalName: 'workspace.project',
    wireName: 'workspace_project',
    args,
    invalidArgs: { ...args, ownerId: '00000000-0000-4000-8000-000000000000' },
    onToolCall: async (call) => {
      expect(ProjectWorkspaceToolInputSchema.parse(call.arguments)).toEqual(
        args,
      );
      return {
        modelContent: 'Synthetic fixed fixture transport accepted.',
        summary: '合成参数往返',
      };
    },
  });
}, 45000);

it('the private live probe cannot be supplied by an ordinary native call or choose its URL and mutation', async () => {
  const args = {
    command: 'verify_live',
    serviceId: '00000000-0000-4000-8000-000000000000',
  };
  expect(BrowserWorkspaceToolInputSchema.safeParse(args).success).toBe(false);
  expect(
    PrivateQualityLiveInputSchema.safeParse({
      ...args,
      url: 'https://example.test',
      script: 'mutate()',
    }).success,
  ).toBe(false);
  await expect(
    runQualityLiveVerification(
      { sessionId: args.serviceId } as RiceToolExecutionInput,
      args,
    ),
  ).rejects.toThrow('QUALITY_PRIVATE_PROBE_REQUIRED');
});
it('the unchanged native browser schema preserves the original assertion and rejects an injected URL', async () => {
  const args = {
    command: 'verify',
    artifact: {
      versionId: '00000000-0000-4000-8000-000000000000',
      checksum: 'sha256:' + 'a'.repeat(64),
    },
    plan: qualityAssertion,
  };
  await nativeBrokerRoundtrip({
    canonicalName: 'browser.workspace',
    wireName: 'browser_workspace',
    args,
    invalidArgs: { ...args, url: 'https://untrusted.example.test' },
    onToolCall: async (call) => {
      expect(BrowserWorkspaceToolInputSchema.parse(call.arguments)).toEqual(
        args,
      );
      return {
        modelContent: 'Synthetic fixed assertion transport accepted.',
        summary: '合成参数往返',
      };
    },
  });
}, 45000);
