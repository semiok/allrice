import { request } from 'node:http';
import type { Duplex } from 'node:stream';
import { LocalCommandError } from './local-command-inputs.js';

/** Docker attach's non-TTY stdin belongs to trusted PID1 only. User program
 * receives a separate pipe and cannot interpret/produce these control frames. */
export class LocalServiceControl {
  private constructor(private readonly socket: Duplex) {}

  static async connect(
    socketPath: string,
    id: string,
  ): Promise<LocalServiceControl> {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new LocalCommandError('INVALID_CONTAINER_ID');
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath,
        path: `/v1.45/containers/${id}/attach?stdin=1&stdout=0&stderr=0&stream=1`,
        method: 'POST',
        headers: { Connection: 'Upgrade', Upgrade: 'tcp' },
      });
      const timer = setTimeout(
        () => req.destroy(new LocalCommandError('SERVICE_CONTROL_TIMEOUT')),
        2500,
      );
      req.once('upgrade', (res, socket, head) => {
        clearTimeout(timer);
        if (res.statusCode !== 101 || head.length) {
          socket.destroy();
          reject(new LocalCommandError('SERVICE_CONTROL_UNAVAILABLE'));
          return;
        }
        // No program output is attached here. logs() is the bounded output path.
        socket.on('error', () => undefined);
        socket.on('data', () => socket.destroy());
        resolve(new LocalServiceControl(socket));
      });
      req.once('response', (res) => {
        clearTimeout(timer);
        res.destroy();
        reject(new LocalCommandError('SERVICE_CONTROL_UNAVAILABLE'));
      });
      req.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      req.end();
    });
  }

  async send(frame: unknown) {
    const text = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(text) > 16_384 || this.socket.destroyed)
      throw new LocalCommandError('SERVICE_CONTROL_UNAVAILABLE');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.destroy();
        reject(new LocalCommandError('SERVICE_CONTROL_TIMEOUT'));
      }, 2000);
      this.socket.write(text, (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  close() {
    this.socket.destroy();
  }
}
