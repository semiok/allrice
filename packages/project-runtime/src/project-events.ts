import { StringDecoder } from 'node:string_decoder';
import { RuntimeCommandError } from './errors.js';
import { LocalCommandOutputFilter } from './command-output.js';

export type ProjectExit = {
  reason:
    | 'exited'
    | 'timeout'
    | 'lease_lost'
    | 'output_limit'
    | 'cache_limit'
    | 'supervisor_failed';
  code: number;
  installation: 'succeeded' | 'failed' | 'interrupted';
};
/** The trusted supervisor wraps tenant output; raw tenant text never becomes evidence. */
export class ProjectEvents {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private size = 0;
  private sequence = 0;
  private filters = {
    stdout: new LocalCommandOutputFilter(),
    stderr: new LocalCommandOutputFilter(),
  };
  stdout = '';
  stderr = '';
  combined = '';
  truncated = false;
  exit?: ProjectExit;
  sourceDigest?: string;
  stage?: 'preparing' | 'running';
  constructor(
    private maximum: number,
    private onOutput?: (chunk: {
      sequence: number;
      stream: 'stdout' | 'stderr';
      text: string;
    }) => void,
  ) {}
  private publish(stream: 'stdout' | 'stderr', text: string) {
    if (!text) return;
    if (
      this.sequence >= 256 ||
      this.size + Buffer.byteLength(text) > this.maximum
    ) {
      this.truncated = true;
      return;
    }
    this.size += Buffer.byteLength(text);
    this[stream] += text;
    this.combined += text;
    this.onOutput?.({ sequence: this.sequence++, stream, text });
  }
  push(bytes: Buffer) {
    this.pending += this.decoder.write(bytes);
    if (this.pending.length > 250_000)
      throw new RuntimeCommandError('INVALID_SUPERVISOR_OUTPUT');
    let n;
    while ((n = this.pending.indexOf('\n')) >= 0) {
      let e;
      try {
        e = JSON.parse(this.pending.slice(0, n));
      } catch {
        throw new RuntimeCommandError('INVALID_SUPERVISOR_OUTPUT');
      }
      this.pending = this.pending.slice(n + 1);
      if (!e || typeof e !== 'object' || this.exit)
        throw new RuntimeCommandError('INVALID_SUPERVISOR_OUTPUT');
      if (e.type === 'stdout' || e.type === 'stderr') {
        if (
          typeof e.data !== 'string' ||
          Buffer.from(e.data, 'base64').toString('base64') !== e.data
        )
          throw new RuntimeCommandError('INVALID_SUPERVISOR_OUTPUT');
        this.publish(
          e.type,
          this.filters[e.type as 'stdout' | 'stderr'].push(
            Buffer.from(e.data, 'base64'),
          ),
        );
      } else if (e.type === 'source_verified') {
        if (this.sourceDigest || !/^sha256:[a-f0-9]{64}$/.test(e.sourceDigest))
          throw new RuntimeCommandError('INVALID_SUPERVISOR_OUTPUT');
        this.sourceDigest = e.sourceDigest;
      } else if (e.type === 'stage') {
        if (!['preparing', 'running'].includes(e.stage))
          throw new RuntimeCommandError('INVALID_SUPERVISOR_OUTPUT');
        this.stage = e.stage;
        this.publish(
          'stderr',
          e.stage === 'preparing'
            ? '正在准备项目依赖…\n'
            : '依赖准备完成，正在运行项目…\n',
        );
      } else if (e.type === 'exit') {
        if (
          ![
            'exited',
            'timeout',
            'lease_lost',
            'output_limit',
            'cache_limit',
            'supervisor_failed',
          ].includes(e.reason) ||
          !Number.isInteger(e.code) ||
          !['succeeded', 'failed'].includes(e.installation)
        )
          throw new RuntimeCommandError('INVALID_SUPERVISOR_OUTPUT');
        this.exit = {
          reason: e.reason,
          code: e.code,
          installation: e.installation,
        };
      } else throw new RuntimeCommandError('INVALID_SUPERVISOR_OUTPUT');
    }
  }
  finish() {
    this.pending += this.decoder.end();
    for (const s of ['stdout', 'stderr'] as const)
      this.publish(s, this.filters[s].push(Buffer.alloc(0), true));
    return {
      stdout: this.stdout,
      stderr: this.stderr,
      combined: this.combined,
      exit: this.exit,
      sourceDigest: this.sourceDigest,
      stage: this.stage,
      truncated:
        this.truncated ||
        !!this.pending ||
        this.filters.stdout.truncated ||
        this.filters.stderr.truncated,
    };
  }
}
