import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema } from '@allrice/contracts';
import { workflowModelUsage } from './workflow-model-usage.js';

const definition = WorkflowDefinitionSchema.parse({
  schemaVersion: 1,
  steps: [
    { key: 'load', name: '读取', kind: 'tool' },
    { key: 'compose', name: '写作', kind: 'model', dependsOn: ['load'] },
  ],
});
const receipt = {
  answer: '真实模型正文',
  usage: { inputTokens: 800, cachedInputTokens: 320, outputTokens: 120 },
  usageComplete: true,
  cacheUsageKnown: true,
};
describe('durable brand workflow usage', () => {
  it('recovers the persisted model receipt without taking tool/model-text claims as usage', () => {
    const result = workflowModelUsage(definition, {
      load: { usage: { inputTokens: 9000 } },
      compose: { ...receipt, answer: '{"usage":{"inputTokens":0}}' },
    });
    expect(result).toEqual({
      usage: receipt.usage,
      usageComplete: true,
      cacheUsageKnown: true,
    });
    expect(workflowModelUsage(definition, { compose: receipt })).toEqual(
      result,
    );
  });
  it('preserves unknown model/cache accounting instead of treating zero as proven free', () => {
    expect(
      workflowModelUsage(definition, {
        compose: { ...receipt, usageComplete: false, cacheUsageKnown: false },
      }),
    ).toMatchObject({
      usage: receipt.usage,
      usageComplete: false,
      cacheUsageKnown: false,
    });
    expect(
      workflowModelUsage(definition, { compose: { answer: 'old checkpoint' } }),
    ).toMatchObject({ usageComplete: false, cacheUsageKnown: false });
  });
  it('records a known zero only when this Workflow has no model node', () => {
    const handoff = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      steps: [{ key: 'handoff', name: '交接', kind: 'tool' }],
    });
    expect(workflowModelUsage(handoff, {})).toEqual({
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      usageComplete: true,
      cacheUsageKnown: true,
    });
  });
});
