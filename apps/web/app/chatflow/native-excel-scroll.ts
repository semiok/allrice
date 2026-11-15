import type { WheelEvent } from 'react';

/**
 * MET-225: authorized private-DOM adapter for documentpreview 0.2.1-rc.2
 * (687f282e8625c6b8d11ff58211a90524be2e4317, Fortune Sheet 1.0.4).
 * ExcelBody exposes no scroll boundary option and cancels wheel even at edges.
 * Keep its private selectors here; mounted XLSX/CSV browser tests are the
 * upgrade contract. Remove this adapter when upstream supports chaining.
 */
const selectors = {
  preview: '[data-excel-preview]',
  grid: '.fortune-sheet-container',
  horizontal: '.luckysheet-scrollbar-x',
  vertical: '.luckysheet-scrollbar-y',
};

function canScroll(delta: number, position: number, maximum: number): boolean {
  return (
    maximum > 0 && (delta < 0 ? position > 0 : delta > 0 && position < maximum)
  );
}

/** Preserve native wheel defaults when Excel has no remaining scroll room. */
export function handleNativeExcelWheelCapture(
  event: WheelEvent<HTMLElement>,
): void {
  if (event.ctrlKey || event.metaKey || event.defaultPrevented) return;
  if (event.deltaX === 0 && event.deltaY === 0) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const preview = target.closest(selectors.preview);
  const grid = target.closest<HTMLElement>(selectors.grid);
  // Formula bar, worksheet tabs and controls outside the grid stay native.
  if (
    !preview ||
    !event.currentTarget.contains(preview) ||
    !grid ||
    !preview.contains(grid)
  )
    return;
  const horizontal = grid.querySelectorAll<HTMLElement>(selectors.horizontal);
  const vertical = grid.querySelectorAll<HTMLElement>(selectors.vertical);
  // Never guess another scrollport if the pinned native structure changes.
  if (horizontal.length !== 1 || vertical.length !== 1) return;
  const x = horizontal.item(0);
  const y = vertical.item(0);
  for (
    let node: Element | null = target;
    node && node !== grid;
    node = node.parentElement
  ) {
    if (!(node instanceof HTMLElement) || node === x || node === y) continue;
    const style = getComputedStyle(node);
    const scrollable = (overflow: string) =>
      overflow === 'auto' || overflow === 'scroll';
    if (
      (event.deltaX !== 0 && scrollable(style.overflowX)) ||
      (event.deltaY !== 0 && scrollable(style.overflowY))
    ) {
      // Native nested lists take precedence over the virtual grid, including
      // their own default chaining when they reach an edge.
      event.stopPropagation();
      return;
    }
  }
  if (
    canScroll(event.deltaX, x.scrollLeft, x.scrollWidth - x.clientWidth) ||
    canScroll(event.deltaY, y.scrollTop, y.scrollHeight - y.clientHeight)
  )
    return;
  // Capture precedes Fortune's unconditional preventDefault. Do not cancel or
  // replay the trusted wheel: the browser chooses the next outer scrollport.
  event.stopPropagation();
}
