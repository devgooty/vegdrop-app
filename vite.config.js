import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

/**
 * Buildpacks commonly leave NODE_ENV=development through the build step on
 * purpose — Railpack/Nixpacks do this so `npm install` still pulls
 * devDependencies, since vite and this plugin live there, and only switch to
 * production for the start command. `vite build` on its own defaults its
 * *mode* to production regardless, but @vitejs/plugin-react's automatic JSX
 * runtime additionally reads process.env.NODE_ENV directly to choose between
 * jsx-runtime and jsx-dev-runtime. Left as 'development', it ships the dev
 * runtime paired with React's development build inside a static multi-chunk
 * bundle — which does not throw, does not log anything, and does not mount.
 * `#root` stays an empty div forever.
 *
 * Forced here, before `@vitejs/plugin-react` is imported, rather than in
 * package.json (`NODE_ENV=production vite build`) so it holds regardless of
 * which shell invokes the build — a prefix-assignment is bash/zsh syntax and
 * silently does nothing under PowerShell or cmd.exe. Scoped to the build
 * command only: `vite` (dev) still wants React's development build for its
 * warnings. The plugin is imported dynamically, after the guard runs, because
 * a static `import` would be hoisted above it and read NODE_ENV too early.
 */
export default defineConfig(async ({ command, mode }) => {
  if (command === 'build') process.env.NODE_ENV = 'production';

  const { default: react } = await import('@vitejs/plugin-react');

  // 'altport' mode runs a second instance of this app side-by-side with the
  // default one, pointed at its own API instead of the default instance's.
  const apiPort = mode === 'altport' ? 5001 : 5000;

  return {
    plugins: [react(), tailwindcss()],

    /**
     * Vitest, for the client half.
     *
     * `include` is scoped to src/ deliberately. server/test/** is a
     * node:test suite driven by `npm test` against an in-memory MongoDB
     * replica set; vitest's default include pattern would match those
     * files too and run them under the wrong runner. The two suites stay
     * separate commands - `npm test` and `npm run test:client`.
     *
     * `environment: 'node'` because what is worth locking here is the pure
     * logic - wire-shape mappers, pack arithmetic, key derivation. A DOM
     * environment (jsdom/happy-dom) is a later addition for component
     * tests, not a prerequisite for these.
     */
    test: {
      include: ['src/**/*.test.{js,jsx,mjs}'],
      environment: 'node',
    },

    server: {
      port: 3000,
      open: false,
      host: true, // Listen on all local IPs
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
          // Strip any Domain so the cookie is host-only for whatever origin the
          // browser used (localhost on laptop, or the LAN IP on phones). Rewriting
          // to 'localhost' broke phone sessions when opening via 192.168.x.x.
          cookieDomainRewrite: '',
        },
      },
    },

    build: {
      // Debuggable production stack traces without shipping readable source.
      sourcemap: 'hidden',
      chunkSizeWarningLimit: 700,

      rollupOptions: {
        output: {
          /**
           * Split vendors by change cadence rather than by size.
           *
           * React and the mapping stack turn over far more slowly than app code,
           * so isolating them means a routine feature deploy invalidates only the
           * small app chunks and returning users re-download almost nothing.
           * Leaflet in particular is large and is only reached from the two panels
           * that actually render a map.
           */
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('react-leaflet') || id.includes('/leaflet')) return 'vendor-maps';
            if (id.includes('react-dom') || id.includes('/react/')) return 'vendor-react';
            if (id.includes('lucide-react')) return 'vendor-icons';
            return 'vendor';
          },
        },
      },
    },
  };
});
