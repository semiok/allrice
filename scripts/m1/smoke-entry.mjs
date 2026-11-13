// Shared by the real smoke runner and its browser entry contract.
export async function startSmokeWork(page, base) {
  await page
    .goto(`${base}/chatflow`, { waitUntil: 'networkidle' })
    .catch(() => {});
  await page
    .getByRole('button', { name: '和 Rice 开新会话', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: '给 Rice 的消息', exact: true })
    .waitFor();
  await page.waitForTimeout(1500);
}
