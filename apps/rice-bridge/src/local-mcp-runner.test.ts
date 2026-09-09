import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { LocalMcpRunner } from './local-mcp-runner.js';
import { LocalCommandRunner } from './local-command-runner.js';
import { LocalCommandError } from './local-command-inputs.js';
import { testImage } from '../test/toolchain.js';

describe('P17 owned orphan recovery never replays MCP', () => {
  const id = 'a'.repeat(64);
  function setup() {
    const base = new LocalCommandRunner({
      socketPath: '/tmp/never-opened-fixture.sock',
      imageDigest: testImage,
    });
    vi.spyOn(base.api, 'verifySocket').mockResolvedValue(undefined);
    const json = vi.spyOn(base.api, 'json');
    return { runner: new LocalMcpRunner(base), json };
  }
  it('only an actual 404 means missing, while API failures remain unknown', async () => {
    const { runner, json } = setup();
    json.mockRejectedValue(new LocalCommandError('DAEMON_HTTP_404'));
    expect(await runner.stopOrphan(randomUUID())).toBe(null);
    json.mockRejectedValue(new LocalCommandError('DAEMON_TIMEOUT'));
    await expect(runner.stopOrphan(randomUUID())).rejects.toThrow(
      'LOCAL_MCP_UNKNOWN',
    );
  });
  it('kills only the exact attempt/image label, verifies stop, and never initializes or deletes', async () => {
    const { runner, json } = setup(),
      attemptId = randomUUID();
    const state = (running: boolean) => ({
      Id: id,
      Config: {
        Image: testImage,
        Labels: { 'xyz.bplabs.allrice.mcp-attempt': attemptId },
      },
      State: { Running: running, Status: running ? 'running' : 'exited' },
    });
    json
      .mockResolvedValueOnce(state(true))
      .mockResolvedValueOnce(state(true))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(state(false));
    expect(await runner.stopOrphan(attemptId)).toEqual({
      containerId: id,
      stopped: true,
    });
    expect(json.mock.calls).toEqual([
      ['GET', `/containers/allrice-mcp-${attemptId}/json`],
      ['GET', `/containers/${id}/json`],
      ['POST', `/containers/${id}/kill?signal=KILL`],
      ['GET', `/containers/${id}/json`],
    ]);
  });
  it('a similarly named container cannot be killed if ownership differs', async () => {
    const { runner, json } = setup();
    json.mockResolvedValue({
      Id: id,
      Config: { Image: testImage, Labels: {} },
      State: { Running: true },
    });
    await expect(runner.stopOrphan(randomUUID())).rejects.toThrow(
      'LOCAL_MCP_UNKNOWN',
    );
    expect(json.mock.calls.every((call) => call[0] === 'GET')).toBe(true);
  });
  it('does not dispose a live container and requires its identity before cleanup', async () => {
    const { runner, json } = setup(),
      attemptId = randomUUID();
    json.mockResolvedValue({
      Id: id,
      Config: {
        Image: testImage,
        Labels: { 'xyz.bplabs.allrice.mcp-attempt': attemptId },
      },
      State: { Running: true, Status: 'running' },
    });
    await expect(runner.cleanup(attemptId, id)).rejects.toThrow(
      'LOCAL_MCP_UNKNOWN',
    );
    expect(json.mock.calls).toHaveLength(1);
  });
});
