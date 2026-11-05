import { describe, expect, it } from 'vitest';
import { parseWorkflowSkillSections } from './workflow-skill.ts';

describe('Workflow author document sections', () => {
  it('preserves the first code block indentation and its original CRLF', () => {
    expect(
      parseWorkflowSkillSections(
        '## 工作步骤\r\n\r\n    code line\r\n    code two\r\n\r\n## 交付内容\r\n\r\n    artifact\r\n\r\n## 执行细节\r\nprivate',
      ),
    ).toEqual({
      stepsMarkdown: '    code line\r\n    code two',
      deliverablesMarkdown: '    artifact',
    });
  });
  it('returns original Markdown, leaves model-only execution details out of display', () => {
    const body =
      '# Weekly\r\n\r\n## 工作步骤\r\n1. **核实**\r\n\r\n### Sources\r\nRead.\r\n\r\n## 交付内容\r\n[report](assets/a.csv)\r\n\r\n## 执行细节\r\nprivate rules';
    expect(parseWorkflowSkillSections(body)).toEqual({
      stepsMarkdown: '1. **核实**\r\n\r\n### Sources\r\nRead.',
      deliverablesMarkdown: '[report](assets/a.csv)',
    });
  });
  it('uses Markdown headings, including setext, and ignores fenced fake headings', () => {
    expect(
      parseWorkflowSkillSections(
        '工作步骤\n---\n```md\n## 执行细节\n```\n## 交付内容\nresult\n## 执行细节\nrules',
      ),
    ).toEqual({
      stepsMarkdown: '```md\n## 执行细节\n```',
      deliverablesMarkdown: 'result',
    });
  });
  it.each([
    '```md\n## 工作步骤\n## 交付内容\n## 执行细节\n```',
    '> ## 工作步骤\n\n## 交付内容\n## 执行细节',
    '- ## 工作步骤\n\n## 交付内容\n## 执行细节',
    '## 工作步骤\n## 执行细节',
    '## 交付内容\n## 工作步骤\n## 执行细节',
    '## 工作步骤\n## 工作步骤\n## 交付内容\n## 执行细节',
  ])('rejects missing, reordered or duplicated framework sections', (body) => {
    expect(() => parseWorkflowSkillSections(body)).toThrow(
      '该技能不符合 workflow 规范。',
    );
  });
  it('ends each display section at the next root section, not at nested headings', () => {
    expect(
      parseWorkflowSkillSections(
        '## 工作步骤\n### A\nstep\n## Other\nnot steps\n## 交付内容\ndeliver\n# Appendix\nnot deliver\n## 执行细节\nprivate',
      ),
    ).toEqual({
      stepsMarkdown: '### A\nstep',
      deliverablesMarkdown: 'deliver',
    });
  });
});
