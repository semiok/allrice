import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The local development server is commonly opened through either loopback
  // hostname. Allow both so Next's HMR/dev resources do not get blocked when
  // the app is opened at http://127.0.0.1:3000.
  allowedDevOrigins: ['localhost', '127.0.0.1'],
};

export default nextConfig;
