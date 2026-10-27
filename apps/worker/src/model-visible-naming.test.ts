import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { platformRepositoryReviewInstructions } from '@allrice/database';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { assembleEmployeeKernel } from './employee-kernel.js';
import { dshHostCapabilityInstructions } from './harness/dsh/tool-bridge.js';
import { riceToolDefinitions } from './tool-broker.js';

// MET-214, user 10-27: the desktop app is 「AllRice 助手」; delegated children
// are 「子智能体」 as in DSH web (设置 → 插件 → 子智能体). The model repeats the
// names it reads (a real run said "请检查 Rice Bridge 连接", "两位助手"), so the
// text it reads must not carry the old ones.
const oldNames = [
  /Rice Bridge|子助手|父助手|父智能体/,
  /(?<![A-Za-z_.$])Bridge(?![A-Za-z_])/,
  // 「技术助手」 is the platform technical assistant's own name.
  /(?<!AllRice )(?<!技术)助手/,
];
// English prose calling a child "assistant"; tool identifiers such as
// assistant.report / assistant_delegate and wire words like assistant/message
// are not prose. The model's own chat turn ("not assistant inference") is not
// a child either.
const englishChild =
  /(?<![\w./-])assistants?(?![\w./-])(?! (?:inference|responses?|guesses))/i;
const prose = (text: string) => /[A-Za-z]+ [A-Za-z]+ [A-Za-z]+/.test(text);

const dsh = resolve(import.meta.dirname, '../dsh');
const harness = resolve(import.meta.dirname, 'harness/dsh');
const repository = resolve(import.meta.dirname, '../../..');

/** String literals and template text, never comments or identifiers. */
function literals(file: string, source: string, only?: 'messages') {
  const out: string[] = [];
  const text = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      out.push(node.text);
    else if (ts.isTemplateExpression(node))
      out.push(
        node.head.text,
        ...node.templateSpans.map((s) => s.literal.text),
      );
    ts.forEachChild(node, text);
  };
  const visit = (node: ts.Node): void => {
    if (!only) return text(node);
    // What a governed tool returns to the model: {message} and HandlerError text.
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      (node.name.text === 'message' || node.name.text === 'summary')
    )
      text(node.initializer);
    else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'HandlerError'
    )
      node.arguments?.slice(1, 2).forEach(text);
    ts.forEachChild(node, visit);
  };
  visit(
    ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ),
  );
  return out.map((literal) => `${file}: ${literal}`);
}

async function sources(dir: string, match: (name: string) => boolean) {
  const names = (await readdir(dir)).filter(
    (name) => match(name) && !name.includes('.test.'),
  );
  return Promise.all(
    names.map(async (name) => ({
      name,
      source: await readFile(join(dir, name), 'utf8'),
    })),
  );
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object')
    return Object.values(value).flatMap(strings);
  return [];
}

async function markdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await markdown(path)));
    else if (entry.name.endsWith('.md'))
      out.push(`${path}\n${await readFile(path, 'utf8')}`);
  }
  return out;
}

const offenders = (texts: string[], english = true) =>
  texts.filter(
    (text) =>
      oldNames.some((name) => name.test(text)) ||
      (english && prose(text) && englishChild.test(text)),
  );

function kernelInstructions() {
  return assembleEmployeeKernel({
    employeeAssignmentId: crypto.randomUUID(),
    employeeVersionId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    userMessageId: crypto.randomUUID(),
    assistantMessageId: crypto.randomUUID(),
    workAutomation: { cloud: true, computer: true, assistants: true },
    resolved: {
      promptSnapshot: {
        systemPrompt: 'Platform',
        userRequest: '下面三段文字请分头并行处理',
        conversation: [],
        memories: [],
      },
      executionSnapshot: null,
      grantedCapabilities: ['model:invoke'],
      nativeSkills: [],
    },
  } as unknown as Parameters<typeof assembleEmployeeKernel>[0])
    .systemInstructions;
}

describe('names the model reads (MET-214)', () => {
  it('the assembled work settings and host instructions name 「AllRice 助手」 and 「子智能体」', () => {
    const kernel = kernelInstructions();
    expect(kernel).toContain(
      'computer=automatic within authorized folders and AllRice 助手',
    );
    expect(kernel).toContain(
      '子智能体=allowed if this task has authorized 子智能体',
    );
    const host = dshHostCapabilityInstructions([
      { name: 'python.execute' },
      { name: 'workspace.export.create' },
    ]);
    expect(host).toContain('AllRice 助手');
    expect(offenders([kernel, host])).toEqual([]);
  });

  it('Broker definitions and the platform repository review instructions carry no old name', () => {
    expect(offenders(strings(riceToolDefinitions))).toEqual([]);
    expect(platformRepositoryReviewInstructions).toContain('主员工');
    expect(offenders([platformRepositoryReviewInstructions])).toEqual([]);
  });

  it('DSH native declarations, prompt sections and governed tool messages carry no old name', async () => {
    const native = (
      await sources(dsh, (name) => name.endsWith('.mjs'))
    ).flatMap(({ name, source }) => literals(name, source));
    expect(native.length).toBeGreaterThan(2000);
    expect(offenders(native)).toEqual([]);
    expect(native.join('\n')).toContain('子智能体 only: deliver');
    const governed = (
      await sources(harness, (name) => /^assistant-.*\.ts$/.test(name))
    ).flatMap(({ name, source }) => literals(name, source, 'messages'));
    expect(governed.join('\n')).toContain('当前任务没有这个子智能体');
    expect(offenders(governed)).toEqual([]);
  });

  it('platform Skills carry no old name', async () => {
    const texts = await markdown(join(repository, 'skills'));
    expect(texts.length).toBeGreaterThan(18);
    // Skills mention the model's own replies ("assistant response"), not children.
    expect(offenders(texts, false)).toEqual([]);
  });
});
