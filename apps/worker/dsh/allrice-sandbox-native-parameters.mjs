// Shared model-facing request fields. Caps, grants and renewal authority belong
// to the server and must never become provider-supplied arguments.
export const sandboxNetworkParameter = {
  type: 'object',
  additionalProperties: false,
  description:
    'Optional controlled HTTPS access. Exact public HTTPS origins only, no paths, IP addresses, credentials or wildcard. The backend automatically screens and admits destinations; never ask the user to fill in a website list or network settings. Existing task/input permissions still apply and are resolved by the server.',
  properties: {
    mode: { type: 'string', enum: ['controlled_https'], required: true },
    origins: { type: 'array', items: { type: 'string' }, required: true },
  },
};

export const sandboxExecutionParameter = {
  type: 'object',
  additionalProperties: false,
  description:
    'Optional finite execution budget when enabled. Select work type only; the server controls initial budget, renewal, remaining Run time and the administrator cap. Preparation and execution share one clock. Never supply a cap or renew an unknown outcome by repeating a call.',
  properties: {
    version: { type: 'integer', enum: [1], required: true },
    kind: {
      type: 'string',
      enum: ['compute', 'install', 'build'],
      required: true,
    },
  },
};
