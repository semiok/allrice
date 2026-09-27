import { describe, expect, it } from 'vitest';
import {
  completedToolWorkMethods,
  operationWorkMethod,
} from './work-methods.ts';

describe('work method evidence boundaries', () => {
  it('requires the action and actual target to agree', () => {
    expect(operationWorkMethod('cloud.process.execute', 'cloud_sandbox')).toBe(
      'cloud_compute',
    );
    expect(
      operationWorkMethod('cloud.process.execute', 'rice_bridge'),
    ).toBeUndefined();
    expect(operationWorkMethod('cloud.browser.act', 'cloud_sandbox')).toBe(
      'cloud_browser',
    );
    expect(operationWorkMethod('local.browser.act', 'rice_bridge')).toBe(
      'bridge_browser',
    );
    expect(operationWorkMethod('cloud.mcp.call', 'cloud_mcp')).toBe(
      'cloud_apps',
    );
    expect(operationWorkMethod('local.mcp.call', 'rice_bridge')).toBe(
      'bridge_apps',
    );
    expect(operationWorkMethod('local.fs.write', 'rice_bridge')).toBe(
      'bridge_files',
    );
    expect(operationWorkMethod('local.fs.mkdir', 'rice_bridge')).toBe(
      'bridge_files',
    );
    expect(
      operationWorkMethod('local.process.status', 'rice_bridge'),
    ).toBeUndefined();
    expect(
      operationWorkMethod('local.mcp.discover', 'rice_bridge'),
    ).toBeUndefined();
    expect(operationWorkMethod('unknown', 'cloud_sandbox')).toBeUndefined();
    expect(operationWorkMethod('toString', 'constructor')).toBeUndefined();
  });
  it('does not treat an async tool return as evidence of execution', () => {
    for (const name of [
      'cloud.process.execute',
      'local.process.execute',
      'cloud.mcp.call',
      'local.mcp.call',
      'browser.workspace',
      'local.browser.workspace',
      'local.preview.open',
      'local.fs.write',
    ])
      expect(completedToolWorkMethods[name]).toBeUndefined();
  });
});
