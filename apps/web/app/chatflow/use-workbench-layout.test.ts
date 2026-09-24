import { describe, expect, it } from 'vitest';
import {
  layoutPreferenceKey,
  parseLayoutPreferences,
} from './use-workbench-layout';

describe('workbench layout preferences', () => {
  it('isolates by authenticated viewer, organization and workspace; never uses a shared anonymous key', () => {
    const key = layoutPreferenceKey('u', 'o', 'w');
    expect(key).not.toBe(layoutPreferenceKey('v', 'o', 'w'));
    expect(key).not.toBe(layoutPreferenceKey('u', 'p', 'w'));
    expect(key).not.toBe(layoutPreferenceKey('u', 'o', 'x'));
    expect(layoutPreferenceKey(undefined, 'o', 'w')).toBeNull();
    expect(layoutPreferenceKey('u', undefined, 'w')).toBeNull();
    expect(layoutPreferenceKey('u:o', 'p', 'w')).not.toBe(
      layoutPreferenceKey('u', 'o:p', 'w'),
    );
  });
  it('accepts typed preferences, with safe defaults for corrupt / unavailable storage', () => {
    for (const raw of [
      null,
      '{',
      'null',
      '42',
      '{"panelOpen":"false","sidebarCollapsed":1}',
    ])
      expect(parseLayoutPreferences(raw)).toEqual({
        panelOpen: true,
        sidebarCollapsed: false,
        sidebarWidth: null,
        panelWidth: null,
      });
    expect(
      parseLayoutPreferences(
        '{"panelOpen":false,"sidebarCollapsed":true,"token":"ignored"}',
      ),
    ).toEqual({
      panelOpen: false,
      sidebarCollapsed: true,
      panelWidth: null,
      sidebarWidth: null,
    });
  });
  it('reads prior preferences without a width and rejects malformed widths', () => {
    for (const panelWidth of [null, '600', -1, 0, 339])
      expect(
        parseLayoutPreferences(JSON.stringify({ panelWidth })).panelWidth,
      ).toBeNull();
    expect(
      parseLayoutPreferences('{"panelWidth":1e999}').panelWidth,
    ).toBeNull();
    expect(parseLayoutPreferences('{"panelWidth":640}').panelWidth).toBe(640);
    for (const sidebarWidth of [null, '320', -1, 239, 421])
      expect(
        parseLayoutPreferences(JSON.stringify({ sidebarWidth })).sidebarWidth,
      ).toBeNull();
    expect(parseLayoutPreferences('{"sidebarWidth":320}').sidebarWidth).toBe(
      320,
    );
  });
});
