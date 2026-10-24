import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema } from './capabilities.ts';
import {
  brandContentTemplateKeys,
  BrandContentWorkflowStageSchema,
} from './brand-content-workflow.ts';
import {
  brandContentMethodText,
  brandContentWorkflowTemplates,
} from './brand-content-templates.ts';

describe('Brand content native workflow templates', () => {
  it('maps every explicit business stage to its stable key and a valid DAG', () => {
    expect(
      brandContentWorkflowTemplates.map((template) => template.stage),
    ).toEqual(BrandContentWorkflowStageSchema.options);
    for (const template of brandContentWorkflowTemplates) {
      expect(template.templateKey).toBe(
        brandContentTemplateKeys[template.stage],
      );
      expect(WorkflowDefinitionSchema.parse(template.definition)).toEqual(
        template.definition,
      );
      expect(template.definition.inputSchema['x-allrice-brand-content']).toBe(
        template.stage,
      );
    }
    expect(
      new Set(
        brandContentWorkflowTemplates.map((template) => template.templateKey),
      ).size,
    ).toBe(5);
  });

  it('passes dependency outputs to the deterministic adapter rather than static arguments', () => {
    for (const template of brandContentWorkflowTemplates) {
      const tools = template.definition.steps.filter(
        (step) => step.kind === 'tool',
      );
      for (const step of tools) {
        expect(step.input.toolName).toBe('workspace.brand_content.step');
        expect(step.input.requiredCapability).toBe('storage:write');
        expect(step.input).not.toHaveProperty('arguments');
      }
      expect(template.definition.steps[0]!.input.action).toBe('load');
    }
  });

  it.each(['topics', 'article', 'revision'])(
    'isolates %s composition from idempotent persistence',
    (stage) => {
      const template = brandContentWorkflowTemplates.find(
        (candidate) => candidate.stage === stage,
      )!;
      expect(template.definition.steps.map((step) => step.kind)).toEqual([
        'tool',
        'model',
        'tool',
      ]);
      const compose = template.definition.steps[1]!;
      expect(compose.dependsOn).toEqual(['load']);
      expect(compose.sideEffect).toBe('none');
      expect(compose.input.instruction).toContain('不要调用任何工具');
      const save = template.definition.steps[2]!;
      expect(save.dependsOn).toEqual(['load', 'compose']);
      expect(save.sideEffect).toBe('idempotent');
      expect(save.input.action).toBe(
        stage === 'topics' ? 'save_topics' : 'save_article',
      );
    },
  );

  it('handoff only reads and assembles the approved version, without a generation or scheduling node', () => {
    const template = brandContentWorkflowTemplates.find(
      (candidate) => candidate.stage === 'handoff',
    )!;
    expect(template.definition.steps.map((step) => step.kind)).toEqual([
      'tool',
      'tool',
    ]);
    expect(template.definition.steps[1]!.input.action).toBe('handoff');
    expect(
      template.definition.steps.every((step) => step.sideEffect === 'none'),
    ).toBe(true);
  });

  it('preserves one exact common method and leaves business decisions with the human', () => {
    expect(brandContentMethodText.endsWith('\n')).toBe(true);
    expect(brandContentMethodText).toContain('模型不得代真人采纳或弃选');
    expect(brandContentMethodText).toContain('不得用旧审批批准新稿');
    expect(brandContentMethodText).toContain('实际时间');
  });
});
