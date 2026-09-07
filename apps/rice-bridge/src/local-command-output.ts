import { StringDecoder } from 'node:string_decoder';

/** Bounded, line-oriented output boundary. Never emit an incomplete credential
 * candidate just because it crossed a transport chunk. This is defense in depth:
 * the runner must still exclude credentials/host environment from the sandbox.
 */
export class LocalCommandOutputFilter {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private dropping = false;
  private privateKey = false;
  truncated = false;
  push(bytes: Buffer, end = false) {
    this.pending += this.decoder.write(bytes) + (end ? this.decoder.end() : '');
    let result = '';
    while (this.pending.includes('\n')) {
      const index = this.pending.indexOf('\n');
      const line = this.pending.slice(0, index + 1);
      this.pending = this.pending.slice(index + 1);
      if (!this.dropping) result += this.line(line);
      this.dropping = false;
    }
    if (this.pending.length > 4096) {
      if (!this.dropping) result += '[过长输出行已省略]\n';
      this.pending = '';
      this.dropping = true;
      this.truncated = true;
    }
    if (end && this.pending) {
      if (!this.dropping) result += this.line(this.pending);
      this.pending = '';
    }
    return result;
  }
  private line(text: string) {
    if (/-----BEGIN .*PRIVATE KEY-----/.test(text)) this.privateKey = true;
    if (this.privateKey) {
      if (/-----END .*PRIVATE KEY-----/.test(text)) this.privateKey = false;
      return '[私钥内容已省略]\n';
    }
    if (text.length > 4096) {
      this.truncated = true;
      return '[过长输出行已省略]\n';
    }
    return Array.from(text)
      .filter((c) => {
        const n = c.charCodeAt(0);
        return n === 9 || n === 10 || n === 13 || (n >= 32 && n !== 127);
      })
      .join('')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
        '[REDACTED]',
      )
      .replace(
        /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
        '$1[REDACTED]',
      );
  }
}
