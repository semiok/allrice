import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { nodeProjectSupervisor } from './project-supervisor.ts';

it.each([true, false])(
  'passes only the exact service host to live=%s children without inherited credentials',
  async (live) => {
    const start = nodeProjectSupervisor.indexOf('const run=(exe,args'),
      end = nodeProjectSupervisor.indexOf('\nasync function ownership', start);
    let environment: Record<string, string | undefined> = {};
    const spawn = (
      _exe: string,
      _args: string[],
      options: { env: typeof environment },
    ) => {
      environment = options.env;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    };
    const run = runInNewContext(
      `${nodeProjectSupervisor.slice(start, end)};run`,
      {
        spawn,
        root: '/tmp/work',
        a: { command: { path: '.', limits: { outputBytes: 1024 } } },
        process: {
          env: {
            ALLRICE_SERVICE_PREVIEW_HOST: 'rice-preview-owned.bplabs.xyz:443',
            ALLRICE_BRIDGE_DEVICE_TOKEN: 'synthetic-private-token',
          },
        },
        projectServiceStarted: async () => {},
        constants: { signals: {} },
        clearTimeout,
      },
    );
    expect(await run('/usr/local/bin/node', ['main.js'], true, live)).toBe(0);
    expect(environment.ALLRICE_SERVICE_PREVIEW_HOST).toBe(
      live ? 'rice-preview-owned.bplabs.xyz' : undefined,
    );
    expect(environment.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS).toBe(
      live ? 'rice-preview-owned.bplabs.xyz' : undefined,
    );
    expect(environment).not.toHaveProperty('ALLRICE_BRIDGE_DEVICE_TOKEN');
  },
);
