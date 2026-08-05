import { describe, expect, it } from 'vitest';

import { makeHealthResponse } from './index.js';

describe('makeHealthResponse', () => {
  it('returns the service, state, and baseline version', () => {
    const response = makeHealthResponse('worker', 'ready');

    expect(response.service).toBe('worker');
    expect(response.status).toBe('ready');
    expect(response.version).toBe('0.1.0');
    expect(Number.isNaN(Date.parse(response.timestamp))).toBe(false);
  });

  it('omits detail when no diagnostic is supplied', () => {
    expect(makeHealthResponse('web', 'live')).not.toHaveProperty('detail');
  });
});
