import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Content-Security-Policy for the production build only (the dev server needs
 * inline scripts for React Fast Refresh). `connect-src 'none'` is the privacy
 * guarantee enforced by the browser itself: the built app cannot open any
 * network connection (fetch, XHR, WebSocket, beacon), so file data cannot leave
 * the machine even if a dependency tried to send it.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }];
    },
  };
}

// Static, backend-free build. `base: './'` keeps asset URLs relative so the
// dist folder can be served from any path (file share, S3 bucket, intranet).
export default defineConfig({
  base: './',
  plugins: [react(), contentSecurityPolicy()],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
  },
});
