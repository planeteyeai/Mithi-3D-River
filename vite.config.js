import { defineConfig } from "vite";

function createProxyErrorHandler(name) {
  return (proxy) => {
    proxy.on("error", (err, _req, res) => {
      console.warn(`[vite-proxy] ${name} error:`, err.message);

      if (res && !res.headersSent && typeof res.writeHead === "function") {
        res.writeHead(504, { "Content-Type": "text/plain" });
        res.end("Gateway Timeout");
      }
    });
  };
}

export default defineConfig({
  assetsInclude: ["**/*.kml", "**/*.kmz", "**/*.glb", "**/*.gltf", "**/*.dae"],

  server: {
    host: true,
    port: 5180,
    strictPort: true,

    // Allow Cloudflare / ngrok tunnel hostnames
    allowedHosts: true,

    watch: {
      // Large / locked data assets under src/data trip Windows EBUSY on fs.watch.
      ignored: [
        "**/*.kml",
        "**/*.tif",
        "**/*.geojson",
        "**/*.glb",
        "**/*.gltf",
        "**/*.bin",
        "**/fish/**",
        "**/public/models/fish/**",
        "**/scratch/**",
        "**/src/data/**",
      ],
    },

    proxy: {
      // Local PostgreSQL history API (lithology + future components)
      "/api/history": {
        target: "http://127.0.0.1:5181",
        changeOrigin: true,
        secure: false,
        timeout: 30000,
        configure: createProxyErrorHandler("history-api"),
      },
      "/api/health": {
        target: "http://127.0.0.1:5181",
        changeOrigin: true,
        secure: false,
        timeout: 10000,
        configure: createProxyErrorHandler("history-health"),
      },

      "/rivereye-api": {
        target: "https://rivereye-production.up.railway.app",
        changeOrigin: true,
        secure: true,
        timeout: 15000,
        rewrite: (path) =>
          path.replace(/^\/rivereye-api/, "/api"),
        configure: createProxyErrorHandler("rivereye-api"),
      },

      "/jalnetra-api": {
        target: "https://jalnetra-software-production.up.railway.app",
        changeOrigin: true,
        secure: true,
        timeout: 30000,
        // Client uses /jalnetra-api + /api/... → strip only the proxy prefix.
        rewrite: (path) => path.replace(/^\/jalnetra-api/, ""),
        configure: createProxyErrorHandler("jalnetra-api"),
      },

      "/osm-overpass": {
        target: "https://overpass-api.de",
        changeOrigin: true,
        secure: true,
        timeout: 10000,
        rewrite: (path) =>
          path.replace(/^\/osm-overpass/, "/api/interpreter"),
        configure: createProxyErrorHandler("osm-overpass-1"),
      },

      "/osm-overpass-2": {
        target: "https://overpass.kumi.systems",
        changeOrigin: true,
        secure: true,
        timeout: 10000,
        rewrite: (path) =>
          path.replace(/^\/osm-overpass-2/, "/api/interpreter"),
        configure: createProxyErrorHandler("osm-overpass-2"),
      },

      "/osm-overpass-3": {
        target: "https://overpass.openstreetmap.fr",
        changeOrigin: true,
        secure: true,
        timeout: 10000,
        rewrite: (path) =>
          path.replace(/^\/osm-overpass-3/, "/api/interpreter"),
        configure: createProxyErrorHandler("osm-overpass-3"),
      },
    },
  },

  build: {
    target: "es2020",
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three")) return "vendor-three";
          if (id.includes("node_modules/geotiff")) return "vendor-geotiff";
          if (id.includes("node_modules/proj4")) return "vendor-proj4";
          if (id.includes("node_modules/chart.js")) return "vendor-chart";
          if (id.includes("node_modules/lucide")) return "vendor-lucide";
          if (id.includes("/src/eye/urban/")) return "eye-urban";
          if (id.includes("/src/eye/services/")) return "eye-services";
        },
        assetFileNames: (assetInfo) => {
          const ext = assetInfo.name.split('.').pop();
          if (['glb', 'gltf', 'dae', 'bin'].includes(ext)) {
            return 'assets/models/[name]-[hash][extname]';
          }
          return 'assets/[name]-[hash][extname]';
        }
      }
    }
  },

  preview: {
    host: true,
    port: 5180,
    strictPort: true,

    proxy: {
      "/osm-overpass": {
        target: "https://overpass-api.de",
        changeOrigin: true,
        secure: true,
        timeout: 10000,
        rewrite: (path) =>
          path.replace(/^\/osm-overpass/, "/api/interpreter"),
        configure: createProxyErrorHandler("osm-overpass-1"),
      },

      "/osm-overpass-2": {
        target: "https://overpass.kumi.systems",
        changeOrigin: true,
        secure: true,
        timeout: 10000,
        rewrite: (path) =>
          path.replace(/^\/osm-overpass-2/, "/api/interpreter"),
        configure: createProxyErrorHandler("osm-overpass-2"),
      },

      "/osm-overpass-3": {
        target: "https://overpass.openstreetmap.fr",
        changeOrigin: true,
        secure: true,
        timeout: 10000,
        rewrite: (path) =>
          path.replace(/^\/osm-overpass-3/, "/api/interpreter"),
        configure: createProxyErrorHandler("osm-overpass-3"),
      },
    },
  },
});
