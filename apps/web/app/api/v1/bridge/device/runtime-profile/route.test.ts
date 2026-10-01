import { afterEach, expect, it, vi } from 'vitest';
import { POST } from './route';
const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  nodeEnabled: vi.fn(),
  nodeReport: vi.fn(),
  pythonReport: vi.fn(),
}));
vi.mock('@allrice/database', () => ({
  bridgeDeviceStatus: mocks.status,
  localCommandEnabled: mocks.nodeEnabled,
  reportLocalCommandProfile: mocks.nodeReport,
  reportLocalPythonProfile: mocks.pythonReport,
}));
afterEach(() => vi.resetAllMocks());
const checksum = `sha256:${'a'.repeat(64)}`;
function profile() {
  return {
    contractVersion: 1,
    profileVersion: 1,
    backend: 'local-vm-container-v1',
    imageId: checksum,
    architecture: 'amd64',
    pythonVersion: '3.11.13',
    packagesChecksum: checksum,
    officeCheckerChecksum: checksum,
    pngCheckerChecksum: checksum,
    fontChecksum: checksum,
    available: true,
    purposes: ['office'],
    officeGeneration: true,
    officeFormulaCalculation: false,
    officePreview: false,
    stopConfirmed: true,
  };
}
function request(body: unknown) {
  return new Request('http://localhost/api/v1/bridge/device/runtime-profile', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
it('reports independently observed Python facts without requiring the Node switch', async () => {
  const value = profile(),
    device = { id: 'owned-test-device' };
  mocks.nodeEnabled.mockReturnValue(false);
  mocks.status.mockResolvedValue({ device });
  mocks.pythonReport.mockResolvedValue(value);
  const response = await POST(request(value));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ profile: value });
  expect(mocks.pythonReport).toHaveBeenCalledWith(device, value);
  expect(mocks.nodeReport).not.toHaveBeenCalled();
});
it('preserves the Node profile endpoint and its existing feature switch', async () => {
  const node = { backend: 'local-vm-container-v1', imageDigest: checksum };
  mocks.status.mockResolvedValue({ device: { id: 'test-device' } });
  mocks.nodeEnabled.mockReturnValue(false);
  expect((await POST(request(node))).status).toBe(404);
  expect(mocks.nodeReport).not.toHaveBeenCalled();
  mocks.nodeEnabled.mockReturnValue(true);
  mocks.nodeReport.mockResolvedValue(node);
  const response = await POST(request(node));
  expect(response.status).toBe(200);
  expect(mocks.nodeReport).toHaveBeenCalledWith({ id: 'test-device' }, node);
  expect(mocks.pythonReport).not.toHaveBeenCalled();
});
it('rejects unobserved readiness, revoked authority and unbounded reports', async () => {
  mocks.status.mockResolvedValue({ device: { id: 'test-device' } });
  mocks.nodeEnabled.mockReturnValue(false);
  expect(
    (await POST(request({ ...profile(), stopConfirmed: false }))).status,
  ).toBe(404);
  expect(mocks.pythonReport).not.toHaveBeenCalled();
  mocks.status.mockRejectedValue(new Error('revoked'));
  expect((await POST(request(profile()))).status).toBe(403);
  expect((await POST(request({ padding: 'x'.repeat(5000) }))).status).toBe(413);
});
