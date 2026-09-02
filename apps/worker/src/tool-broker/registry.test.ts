import { describe, expect, it } from 'vitest';

import { riceToolDefinitions } from './definitions.js';
import { resolveRiceToolHandler, riceToolHandlerRegistry } from './registry.js';

describe('Tool Broker handler registry', () => {
  it('registers every executable tool definition exactly once', () => {
    expect(Object.keys(riceToolHandlerRegistry).sort()).toEqual(
      riceToolDefinitions.map((definition) => definition.name).sort(),
    );
  });

  it('keeps dispatch categories explicit without matching unknown prefixes', () => {
    expect(resolveRiceToolHandler('workspace.file.read')?.category).toBe(
      'workspace',
    );
    expect(resolveRiceToolHandler('web.search')?.category).toBe('research');
    expect(resolveRiceToolHandler('browser.run')?.category).toBe(
      'managed_browser',
    );
    expect(resolveRiceToolHandler('local.fs.read')?.category).toBe(
      'local_bridge',
    );
    expect(resolveRiceToolHandler('local.fs.write')?.category).toBe(
      'local_bridge',
    );
    expect(resolveRiceToolHandler('local.unregistered')).toBeNull();
  });
});
