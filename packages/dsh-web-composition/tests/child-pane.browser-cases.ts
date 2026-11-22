import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { expect, it } from 'vitest';
import { processSession } from './native-history.mjs';

// Register inside the installed-profile suite; its existing isolated Host and
// cleanup own all resources. No second native process or browser is necessary.
export function childPaneBrowserCases(getPage: () => Page) {
  it('opens the native catalog in a read-only right pane, preserves the parent draft and reopens history', async () => {
    const page = getPage();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(
      (id) => window.__allriceCompositionTest!.openSession(id),
      processSession,
    );
    const parent = page.locator(
      `[data-conversation-session="${processSession}"]`,
    );
    const editor = parent
      .locator('textarea:visible,[contenteditable=true]:visible')
      .first();
    await editor.fill('留在主会话的未发送草稿');
    await page
      .getByRole('button', { name: '1 个子智能体', exact: true })
      .click();
    const tree = page.getByRole('tree', { name: '子智能体会话' });
    await tree.waitFor();
    expect(await tree.innerText()).toContain('复核三条销售记录');
    if (process.env.MET278_CONTINUABLE_FIXTURE === '1')
      expect(await tree.innerText()).toContain('可继续');
    await tree.getByRole('treeitem').first().click();
    const child = page.locator('[data-sidebar-chat]');
    await child
      .getByText('请独立核对三条销售记录。', { exact: true })
      .waitFor();
    await page.getByRole('tab', { name: /复核三条销售记录/ }).waitFor();
    expect(
      await editor.evaluate((node) =>
        node instanceof HTMLTextAreaElement ? node.value : node.textContent,
      ),
    ).toContain('留在主会话的未发送草稿');
    expect(await parent.isVisible()).toBe(true);
    await editor.fill('');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate(
          (mode) => window.__allriceCompositionTest!.setTheme(mode),
          theme,
        );
        await child
          .getByRole('status')
          .filter({ hasText: '只读会话 · 由主员工安排后续工作' })
          .waitFor();
        // Native ConversationContent's overlay:true retains the draft editor
        // under a hidden fallback. Verify it cannot be seen or focused, rather
        // than requiring native draft storage DOM to be destroyed.
        await child
          .getByRole('status')
          .filter({ hasText: '只读会话 · 由主员工安排后续工作' })
          .waitFor();
        expect(
          await child
            .locator('textarea:visible,[contenteditable=true]:visible')
            .count(),
        ).toBe(0);
        expect(
          await child
            .locator('textarea,[contenteditable=true]')
            .evaluateAll((nodes) =>
              nodes.every((node) => {
                const hidden = node.getClientRects().length === 0;
                (node as HTMLElement).focus();
                return hidden && document.activeElement !== node;
              }),
            ),
        ).toBe(true);
        expect(await child.innerText()).toContain('5630');
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        ).toBe(false);
        if (process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR) {
          const directory = resolve(
            process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR,
          );
          await mkdir(directory, { recursive: true });
          await page.screenshot({
            path: resolve(directory, `native-child-${width}-${theme}.png`),
          });
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Full native reload (not a fake store reset) must preserve the addressed
    // child and readonly composer; reselecting the root never targets the child.
    await page.reload();
    await page.waitForFunction(() => !!window.__allriceCompositionTest);
    await page.evaluate(
      (id) => window.__allriceCompositionTest!.openSession(id),
      processSession,
    );
    await page
      .getByRole('button', { name: '1 个子智能体', exact: true })
      .click();
    await tree.getByRole('treeitem').first().click();
    await child
      .getByText('请独立核对三条销售记录。', { exact: true })
      .waitFor();
    await child
      .getByRole('status')
      .filter({ hasText: '只读会话 · 由主员工安排后续工作' })
      .waitFor();
    expect(
      await child
        .locator('textarea:visible,[contenteditable=true]:visible')
        .count(),
    ).toBe(0);
    expect(
      await parent
        .locator('textarea:visible,[contenteditable=true]:visible')
        .count(),
    ).toBe(1);
    await page
      .getByRole('tab', { name: /复核三条销售记录/ })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await child.waitFor({ state: 'detached' });
    expect(await editor.isVisible()).toBe(true);
  });
}
