import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Script } from 'node:vm';
import { expect, it } from 'vitest';
import {
  cloudBudgetSupervisor,
  cloudNetworkBudgetSupervisor,
} from './backend.js';

it.each([cloudBudgetSupervisor, cloudNetworkBudgetSupervisor])(
  'expires the input wait only before input, then honors the execution deadline',
  async (source) => {
    const timers = new Map<object, { at: number; run: () => void }>();
    const exits: number[] = [];
    const kills: string[] = [];
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: (signal: string) => kills.push(signal),
    });
    const now = 1000;
    const done = new Script(
      '(async()=>{' +
        source.replace(
          "import fs from 'node:fs'; import cp from 'node:child_process';",
          '',
        ) +
        '})()',
    ).runInNewContext({
      fs: { mkdirSync() {}, writeFileSync() {} },
      cp: { spawn: () => child },
      process: {
        stdin,
        stdout: { write: (_: string, callback: () => void) => callback() },
        exit: (code: number) => exits.push(code),
      },
      console: { log() {} },
      Buffer,
      Date: { now: () => now },
      setTimeout(run: () => void, ms: number) {
        const timer = {
          unref() {
            return timer;
          },
        };
        timers.set(timer, { at: now + ms, run });
        return timer;
      },
      clearTimeout: (timer: object) => timers.delete(timer),
    }) as Promise<void>;
    expect([...timers.values()].map((t) => t.at)).toEqual([66000]);
    stdin.write(
      JSON.stringify({
        files: [],
        outputs: [],
        script: 'synthetic',
        outputBytes: 1024,
        deadline: 181000,
      }) + '\n',
    );
    await done;
    expect([...timers.values()].map((t) => t.at)).toEqual([181000]);
    for (const timer of timers.values()) if (timer.at <= 71000) timer.run();
    expect(exits).toEqual([]);
    expect(kills).toEqual([]);
    for (const timer of timers.values()) timer.run();
    expect(kills).toEqual(['SIGKILL']);
    expect(exits).toEqual([124]);
    stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  },
);
