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
export default defineConfig(async ({ command }) => {
  if (command === 'build') process.env.NODE_ENV = 'production';

  const { default: react } = await import('@vitejs/plugin-react');

  return {
    plugins: [react(), tailwindcss()],

    server: {
      port: 3000,
      open: false,
      host: true, // Listen on all local IPs
      proxy: {
        '/api': {
          target: 'http://localhost:5000',
          changeOrigin: true,
          // Required for the httpOnly refresh cookie to survive the proxy hop.
          cookieDomainRewrite: 'localhost',
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
