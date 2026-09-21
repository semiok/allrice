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
  it('accepts only boolean preferences, with safe defaults for corrupt / unavailable storage', () => {
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
      });
    expect(
      parseLayoutPreferences(
        '{"panelOpen":false,"sidebarCollapsed":true,"token":"ignored"}',
      ),
    ).toEqual({ panelOpen: false, sidebarCollapsed: true });
  });
});
