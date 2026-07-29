import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
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
});
