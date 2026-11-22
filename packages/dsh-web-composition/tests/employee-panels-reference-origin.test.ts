import { describe, expect, it } from 'vitest';
import type { PanelsCausalSnapshot } from './employee-panels-causal-dom';
import {
  classifyPanelsOriginEffect,
  comparePanelsOriginContent,
  cropPanelsOriginFrame,
} from './employee-panels-reference-origin';
import { screenshotPixels } from './sidebar-pixels';

// Independent 3x2 RGBA PNG, including transparent RGB and non-opaque alpha.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAGUlEQVR4nGP4z8DwHwgbQBQI/AcBLhE5DQB+bQnc+xck1AAAAABJRU5ErkJggg==',
  'base64',
);
describe('saved full-frame panel window', () => {
  it('copies exact source RGBA, rather than taking a second screenshot', () => {
    const original = Buffer.from(png);
    const cropped = screenshotPixels(
      cropPanelsOriginFrame(png, { x: 1, y: 0, width: 2, height: 2 }),
    );
    expect(cropped.width).toBe(2);
    expect(cropped.height).toBe(2);
    expect([...cropped.rgba]).toEqual([
      0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 255, 10, 20, 30, 40,
    ]);
    expect(png.equals(original)).toBe(true);
  });
  it.each([
    { x: 0.5, y: 0, width: 2, height: 1 },
    { x: 2, y: 0, width: 2, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
  ])('rejects a non-exact or out-of-frame window %j', (rect) => {
    expect(() => cropPanelsOriginFrame(png, rect)).toThrow(
      'exact integer rectangle',
    );
  });
});

describe('same-run origin effect', () => {
  const pixels = (formalElement: number, fullFramePanelWindow: number) => ({
    formalElement: { changedPixels: formalElement },
    fullFramePanelWindow: { changedPixels: fullFramePanelWindow },
  });
  const classify = (
    atZero = pixels(56, 80),
    aligned = pixels(0, 0),
    returned = atZero,
    matches = { formalElement: true, fullFramePanelWindow: true },
    valid = true,
  ) =>
    classifyPanelsOriginEffect(valid, { atZero, aligned, returned }, matches);
  it('supports each capture only after a same-run nonzero → zero → exact return', () => {
    const value = classify();
    expect(value.status).toBe('supported');
    expect(value.supportsReferenceOrigin).toBe(true);
    expect(Object.values(value.captures).map((item) => item.status)).toEqual([
      'supported',
      'supported',
    ]);
  });
  it('does not claim support when both capture types already match', () => {
    const value = classify(pixels(0, 0));
    expect(value.status).toBe('no-observable-effect');
    expect(value.supportsReferenceOrigin).toBe(false);
  });
  it('retains per-capture no-effect instead of borrowing the other capture contrast', () => {
    const value = classify(pixels(0, 80));
    expect(value.status).toBe('not-supported');
    expect(value.captures.formalElement.status).toBe('no-observable-effect');
    expect(value.captures.fullFramePanelWindow.status).toBe('supported');
    expect(value.supportsReferenceOrigin).toBe(false);
  });
  it('does not support a residual that stays nonzero after alignment', () => {
    expect(classify(pixels(56, 80), pixels(1, 0)).status).toBe('not-supported');
  });
  it('requires the returned residual to reproduce the current zero-origin state', () => {
    expect(classify(pixels(56, 80), pixels(0, 0), pixels(55, 80)).status).toBe(
      'not-supported',
    );
  });
  it('requires exact returned reference bytes even if residual counts match', () => {
    expect(
      classify(undefined, undefined, undefined, {
        formalElement: false,
        fullFramePanelWindow: true,
      }).supportsReferenceOrigin,
    ).toBe(false);
  });
  it('keeps an invalid experiment separate from a supported pixel pattern', () => {
    const value = classify(undefined, undefined, undefined, undefined, false);
    expect(value.status).toBe('invalid-experiment');
    expect(value.supportsReferenceOrigin).toBe(false);
  });
});

const measured = (x: number, y: number) =>
  ({
    root: { x, y, width: 647, height: 962 },
    nodes: [
      {
        tag: 'SECTION',
        text: 'same real content',
        focused: false,
        hovered: false,
        bbox: null,
        matrix: null,
        animations: [],
        rect: { x: x + 16, y: y + 22, width: 28, height: 28 },
        styles: { color: 'rgb(97, 102, 107)', '--dsw-corner-shape': 'round' },
        before: {},
        after: {},
      },
    ],
  }) as unknown as PanelsCausalSnapshot;

describe('measured cross-side content differences', () => {
  it('normalizes only the measured absolute origin', () => {
    expect(
      comparePanelsOriginContent(measured(793, 38), measured(0, 0)),
    ).toEqual([]);
  });
  it('preserves the raw corner-token difference as evidence', () => {
    const reference = measured(0, 0);
    reference.nodes[0]!.styles['--dsw-corner-shape'] = '';
    expect(comparePanelsOriginContent(measured(793, 38), reference)).toEqual([
      {
        node: 0,
        field: 'styles.--dsw-corner-shape',
        native: 'round',
        reference: '',
      },
    ]);
  });
  it('does not normalize away paint or relative geometry differences', () => {
    const reference = measured(793, 38);
    reference.nodes[0]!.styles.color = 'rgb(94, 99, 104)';
    reference.nodes[0]!.rect.width = 29;
    expect(
      comparePanelsOriginContent(measured(793, 38), reference).map(
        (entry) => entry.field,
      ),
    ).toEqual(['local-rect', 'styles.color']);
  });
});
