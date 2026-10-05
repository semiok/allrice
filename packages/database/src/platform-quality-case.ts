import { BrowserVerificationPlanSchema } from '@allrice/contracts';
import type { CreateQualityCheck } from './platform-quality-contracts.ts';
import {
  qualityLiveFiles,
  qualityLiveAssertion,
  qualityLiveRunnerVersion,
} from './platform-quality-live-case.ts';
export { technicalDigest as qualityDigest } from './platform-technical-tasks.ts';

export const qualityCaseId = 'project.static.v1';
export const qualityRunnerVersion = 'fixed-project-static/1';
export const qualityAssertion = BrowserVerificationPlanSchema.parse({
  version: 1,
  timeoutMs: 15000,
  steps: [
    { type: 'click', selector: { tag: 'button', label: '计算' } },
    { type: 'text_contains', expected: '结果：2' },
  ],
});
export const qualityLock =
  "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n";
export function qualityFixture(variant: CreateQualityCheck['variant']) {
  const result = variant === 'defect' ? 3 : 2;
  const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>AllRice 固定质检样例</title><body><h1>1 + 1</h1><button onclick="document.getElementById('result').textContent='结果：${result}'">计算</button><p id="result">等待计算</p></body></html>`;
  return {
    html,
    files: [
      {
        path: 'package.json',
        text: '{"name":"allrice-quality-sample","private":true,"type":"module","packageManager":"pnpm@10.33.3"}\n',
      },
      { path: 'pnpm-lock.yaml', text: qualityLock },
      { path: 'input.html', text: html },
      {
        path: 'build.mjs',
        text: "import {mkdirSync,copyFileSync} from 'node:fs';mkdirSync('dist',{recursive:true});copyFileSync('input.html','dist/index.html');console.log('fixed build completed');\n",
      },
    ].sort((a, b) => a.path.localeCompare(b.path)),
  };
}
export function qualityCaseSpec(
  caseId: CreateQualityCheck['caseId'],
  variant: CreateQualityCheck['variant'],
) {
  return caseId === 'project.live.v1'
    ? {
        files: qualityLiveFiles,
        assertion: qualityLiveAssertion,
        runnerVersion: qualityLiveRunnerVersion,
      }
    : {
        files: qualityFixture(variant).files,
        assertion: qualityAssertion,
        runnerVersion: qualityRunnerVersion,
      };
}
