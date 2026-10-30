import { describe, expect, it } from 'vitest';
import { createSseDataConsumer } from './sse-data-consumer';

describe('shared SSE wire framing', () => {
  it('preserves UTF-8 when every byte, including a frame delimiter, is split', () => {
    const consume = createSseDataConsumer();
    const text = JSON.stringify({ text: '子智能体正在读取🌾' });
    const bytes = new TextEncoder().encode(`data: ${text}\n\n`);
    const values = [...bytes].flatMap((byte) => consume(Uint8Array.of(byte)));
    expect(values).toEqual([text]);
  });

  it('handles CRLF, multiple frames, multiline data and metadata without interpreting events', () => {
    const consume = createSseDataConsumer();
    const encode = (value: string) => new TextEncoder().encode(value);
    expect(
      consume(encode(': keepalive\r\nid: 8\r\ndata: first\r\n\r')),
    ).toEqual([]);
    expect(
      consume(
        encode(
          '\ndata:second\r\ndata: third\r\n\r\nevent: display\ndata: fourth\n\n',
        ),
      ),
    ).toEqual(['first', 'second\nthird', 'fourth']);
  });

  it('keeps incomplete frames private and gives each connection an independent buffer', () => {
    const a = createSseDataConsumer(),
      b = createSseDataConsumer();
    expect(a(new TextEncoder().encode('data: old partial'))).toEqual([]);
    expect(b(new TextEncoder().encode('data: new cut\n\n'))).toEqual([
      'new cut',
    ]);
    expect(a(new TextEncoder().encode('\n\n'))).toEqual(['old partial']);
  });
});
