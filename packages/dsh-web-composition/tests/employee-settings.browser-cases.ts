import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';

/** Supplied by the owner's installed-profile suite, using its real owner port. */
export interface EmployeeSettingsInstalledBrowserHarness {
  page: () => Page;
  artifacts: () => string;
  /** Calls the native openSettings received by the launcher adapter. */
  openSettings: () => Promise<void>;
  setTheme: (theme: 'light' | 'dark') => Promise<void>;
  /** A controlled authenticated owner holds one preference response. */
  holdPreferenceWrite: () => Promise<void>;
  switchIdentity: () => Promise<void>;
  releaseHeldPreferenceWrite: () => Promise<void>;
  revokeIdentity: () => Promise<void>;
  ownerEvidence: () => Promise<{
    accountOpened: number;
    oldSignalAborted: boolean;
    lateResponseApplied: boolean;
    notificationCalls: number;
  }>;
}

/**
 * Real installed-shell cases. The owner calls this inside its lifecycle suite.
 * This file starts no browser/Host and supplies no fake product owner itself.
 */
export function employeeSettingsBrowserCases(
  harness: EmployeeSettingsInstalledBrowserHarness,
) {
  const select = async (label: string) => {
    await harness.openSettings();
    await harness
      .page()
      .getByRole('button', { name: label, exact: true })
      .click();
  };

  describe('installed employee settings', () => {
    it('opens the existing account surface through the real native settings entry', async () => {
      await select('AllRice 账号');
      await harness
        .page()
        .getByRole('button', { name: '打开账号设置', exact: true })
        .click();
      expect((await harness.ownerEvidence()).accountOpened).toBe(1);
      await harness.page().getByText('修改登录密码', { exact: true }).waitFor();
      await harness
        .page()
        .getByRole('button', { name: '退出登录', exact: true })
        .waitFor();
      await harness.page().getByText('文件存储', { exact: true }).waitFor();
      // No password submission, logout or real personal account mutation here.
    });

    it('keeps native general controls and the existing streaming preference, without M1 notification switches', async () => {
      await select('通用');
      const page = harness.page();
      await page
        .getByRole('switch', { name: '流式输出', exact: true })
        .waitFor();
      for (const name of ['任务完成通知', '需要确认通知'])
        expect(
          await page.getByRole('switch', { name, exact: true }).count(),
        ).toBe(0);
      expect((await harness.ownerEvidence()).notificationCalls).toBe(0);
      expect(await page.getByText('设计预览', { exact: false }).count()).toBe(
        0,
      );
      expect(await page.getByText('未连接 API', { exact: false }).count()).toBe(
        0,
      );
      for (const label of ['模型', '插件', '账号'])
        expect(
          await page.getByRole('button', { name: label, exact: true }).count(),
        ).toBe(0);
    });

    it('shows the existing computer, work and linked-app surfaces through authenticated owner content', async () => {
      await select('我的电脑');
      await harness
        .page()
        .getByRole('button', { name: '连接与管理电脑', exact: true })
        .waitFor();
      await select('工作方式');
      await harness
        .page()
        .getByRole('switch', { name: '云端自动工作', exact: true })
        .waitFor();
      await harness
        .page()
        .getByRole('switch', { name: '电脑自动工作', exact: true })
        .waitFor();
      await select('已链接应用');
      await harness
        .page()
        .getByRole('region', { name: '已链接应用', exact: true })
        .waitFor();
    });

    it('aborts the previous identity request and ignores its late preference result', async () => {
      await select('通用');
      const page = harness.page();
      await harness.holdPreferenceWrite();
      await page.getByRole('switch', { name: '流式输出', exact: true }).click();
      await harness.switchIdentity();
      await harness.releaseHeldPreferenceWrite();
      const evidence = await harness.ownerEvidence();
      expect(evidence.oldSignalAborted).toBe(true);
      expect(evidence.lateResponseApplied).toBe(false);
      await harness.revokeIdentity();
      expect(
        await page
          .getByRole('switch', { name: '流式输出', exact: true })
          .count(),
      ).toBe(0);
    });

    it('captures account entry at 1440/390 in both themes without changing the approved controls', async () => {
      const page = harness.page();
      const output = join(harness.artifacts(), 'employee-settings');
      await mkdir(output, { recursive: true });
      for (const width of [1440, 390]) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 1000,
        });
        for (const theme of ['light', 'dark'] as const) {
          await harness.setTheme(theme);
          await select('AllRice 账号');
          await page
            .getByRole('button', { name: '打开账号设置', exact: true })
            .waitFor();
          const pageWidth = await page.evaluate(
            () => document.documentElement.scrollWidth,
          );
          expect(pageWidth).toBeLessThanOrEqual(width);
          await page.screenshot({
            path: join(output, `account-${width}-${theme}.png`),
            fullPage: true,
            animations: 'disabled',
          });
        }
      }
    });
  });
}
