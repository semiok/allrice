import { describe, expect, it } from 'vitest';
import {
  PlatformModelSettingsSchema,
  UpdatePlatformModelSettingsSchema,
} from './platform-model-settings.ts';

const configuration = {
  connectionId: '52000000-0000-4000-8000-000000000001',
  workModel: 'gpt-6-luna',
  reasoningEffort: 'xhigh',
  timeoutMs: 300_000,
  imageModel: 'auto',
  imagesEnabled: true,
};

describe('current model selections and historical receipts', () => {
  it.each(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.3-codex-spark'])(
    'accepts %s for new configuration',
    (workModel) => {
      expect(
        UpdatePlatformModelSettingsSchema.safeParse({
          expectedRevision: 1,
          configuration: { ...configuration, workModel },
        }).success,
      ).toBe(true);
    },
  );
  it.each([
    'gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
  ])(
    'retains %s in historical snapshots but rejects new selections',
    (workModel) => {
      const old = { ...configuration, workModel };
      expect(
        PlatformModelSettingsSchema.parse({
          revision: 1,
          configuration: old,
          updatedAt: new Date().toISOString(),
        }).configuration.workModel,
      ).toBe(workModel);
      expect(
        UpdatePlatformModelSettingsSchema.safeParse({
          expectedRevision: 1,
          configuration: old,
        }).success,
      ).toBe(false);
    },
  );
});
