import { expect, it } from 'vitest';
import { ProjectWorkspaceToolInputSchema } from '@allrice/contracts';
import { qualityFixture, qualityAssertion } from '@allrice/database';
import { BrowserWorkspaceToolInputSchema } from '../browser-control/tool-input.js';
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
