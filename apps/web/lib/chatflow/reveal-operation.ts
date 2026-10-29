/** Reveal existing transcript disclosures before following an operation link. */
export function revealOperation(operationId: string) {
  const target = document.getElementById(`operation-${operationId}`);
  if (!target) return false;
  const process = target.closest('[data-process-open="false"]');
  process?.querySelector<HTMLElement>('[data-disclosure-row]')?.click();
  const group = target.closest('[data-work-group-open="false"]');
  group?.querySelector<HTMLElement>('[data-disclosure-row]')?.click();
  if (target.hasAttribute('data-work-call')) {
    const row = target.querySelector<HTMLElement>('[data-disclosure-row]');
    if (row?.getAttribute('aria-expanded') === 'false') row.click();
  }
  requestAnimationFrame(() => {
    target.tabIndex = -1;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.focus({ preventScroll: true });
  });
  return true;
}
