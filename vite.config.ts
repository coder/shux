import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import topLevelAwait from "vite-plugin-top-level-await";
import svgr from "vite-plugin-svgr";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { fileURLToPath } from "url";
import { BROWSER_BRIDGE_WS_PATH, DESKTOP_WS_PATH } from "./src/node/orpc/wsPaths";
import { novncCompatPlugin } from "./src/vite/novncCompatPlugin";
import { resolveViteDevServerEnv } from "./src/vite/devServerEnv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const disableMermaid = process.env.VITE_DISABLE_MERMAID === "1";

const {
  host: devServerHost,
  port: devServerPort,
  allowedHosts: devServerAllowedHosts,
  previewPort,
  backendHost: backendProxyHost,
  backendPort: backendProxyPort,
  enableTutorialsInSandbox,
} = resolveViteDevServerEnv(process.env);

const enableTutorialsInSandboxDefine =
  enableTutorialsInSandbox == null ? "null" : JSON.stringify(enableTutorialsInSandbox === "1");

function formatHostForUrl(host: string): string {
  const trimmed = host.trim();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;

  // IPv6 URLs must be bracketed: http://[::1]:1234
  if (unbracketed.includes(":")) {
    // If the host contains a zone index (e.g. fe80::1%en0), percent must be encoded.
    // Encode zone indices (including numeric ones like %12) while avoiding double-encoding
    // if the user already provided a URL-safe %25.
    const escaped = unbracketed.replace(/%(?!25)/gi, "%25");
    return `[${escaped}]`;
  }

  return unbracketed;
}

// In dev-server mode we run the backend on a separate local port, but we want the
// browser UI to talk to it via same-origin paths (single public port).
const backendProxyTarget = `http://${formatHostForUrl(backendProxyHost)}:${backendProxyPort}`;

const alias: Record<string, string> = {
  "@": path.resolve(__dirname, "./src"),
};

if (disableMermaid) {
  alias["mermaid"] = path.resolve(__dirname, "./src/mocks/mermaidStub.ts");
}

// React Compiler configuration
// Automatically optimizes React components through memoization
// See: https://react.dev/learn/react-compiler
const reactCompilerConfig = {
  target: "18", // Target React 18 (requires react-compiler-runtime package)
};

// Babel plugins configuration (shared between dev and production)
const babelPlugins = [["babel-plugin-react-compiler", reactCompilerConfig]];

// Base plugins for both dev and production
const basePlugins = [
  svgr(),
  react({
    babel: {
      plugins: babelPlugins,
    },
  }),
  tailwindcss(),
  novncCompatPlugin(),
];

export default defineConfig(({ mode }) => {
  const isProfiling = mode === "profiling";
  const aliasMap: Record<string, string> = { ...alias };

  if (isProfiling) {
    aliasMap["react-dom$"] = "react-dom/profiling";
    aliasMap["scheduler/tracing"] = "scheduler/tracing-profiling";
  }

  return {
    plugins: mode === "development" ? [...basePlugins, topLevelAwait()] : basePlugins,
    resolve: {
      alias: aliasMap,
    },
    define: {
      "globalThis.__MUX_ENABLE_TUTORIALS_IN_SANDBOX__": enableTutorialsInSandboxDefine,
      ...(isProfiling ? { __PROFILE__: "true" } : {}),
    },
    base: "./",
    build: {
      outDir: "dist",
      assetsDir: ".",
      emptyOutDir: false,
      sourcemap: true,
      minify: "esbuild",
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, "index.html"),
          terminal: path.resolve(__dirname, "terminal.html"),
          desktop: path.resolve(__dirname, "desktop.html"),
        },
        output: {
          format: "es",
          inlineDynamicImports: false,
          sourcemapExcludeSources: false,
          manualChunks(id) {
            const normalizedId = id.split(path.sep).join("/");
            if (normalizedId.includes("node_modules/ai-tokenizer/encoding/")) {
              const chunkName = path.basename(id, path.extname(id));
              return `tokenizer-encoding-${chunkName}`;
            }
            if (normalizedId.includes("node_modules/ai-tokenizer/")) {
              return "tokenizer-base";
            }
            return undefined;
          },
        },
      },
      chunkSizeWarningLimit: 2000,
      target: "esnext",
    },
    worker: {
      format: "es",
      plugins: () => [topLevelAwait()],
    },
    server: {
      host: devServerHost, // Configurable via XUM_VITE_HOST (loopback by default)
      port: devServerPort,
      strictPort: true,
      allowedHosts: devServerAllowedHosts,

      proxy: {
        "/orpc": {
          target: backendProxyTarget,
          // Preserve the original Host so backend origin validation compares against
          // the public dev-server origin (localhost:5173) instead of 127.0.0.1:3000.
          changeOrigin: false,
          ws: true,
        },
        [BROWSER_BRIDGE_WS_PATH]: {
          target: backendProxyTarget,
          changeOrigin: false,
          ws: true,
        },
        [DESKTOP_WS_PATH]: {
          target: backendProxyTarget,
          changeOrigin: false,
          ws: true,
        },
        "/api": {
          target: backendProxyTarget,
          // Preserve Host for backend origin validation (same rationale as /orpc).
          changeOrigin: false,
        },
        "/auth": {
          target: backendProxyTarget,
          // Preserve the original Host so mux can generate OAuth redirect URLs that
          // point back to the public dev-server origin (not 127.0.0.1:3000).
          changeOrigin: false,
        },
        "/health": {
          target: backendProxyTarget,
          changeOrigin: true,
        },
        "/version": {
          target: backendProxyTarget,
          changeOrigin: true,
        },
      },
      sourcemapIgnoreList: () => false, // Show all sources in DevTools

      watch: {
        // Ignore node_modules to drastically reduce file handle usage
        ignored: ["**/node_modules/**", "**/dist/**", "**/.git/**"],

        // Use polling on Windows to avoid file handle exhaustion
        // This is slightly less efficient but much more stable
        usePolling: process.platform === "win32",

        // If using polling, set a reasonable interval (in milliseconds)
        interval: 1000,

        // Additional options for Windows specifically
        ...(process.platform === "win32" && {
          // Increase the binary interval for better Windows performance
          binaryInterval: 1000,
          // Use a more conservative approach to watching
          awaitWriteFinish: {
            stabilityThreshold: 500,
            pollInterval: 100,
          },
        }),
      },

      // Note: leave `server.hmr` unset so Vite derives the websocket URL from the
      // served script URL (works when accessed via reverse proxy / custom domain).
    },
    preview: {
      host: "127.0.0.1",
      port: previewPort,
      strictPort: true,
      allowedHosts: ["localhost", "127.0.0.1"],
    },
    optimizeDeps: {
      // noVNC ships Babel-style CJS plus top-level await in lib/, which breaks esbuild
      // pre-bundling. Keep it excluded so novncCompatPlugin can rewrite it on demand.
      exclude: ["@novnc/novnc"],

      // Limit dependency pre-bundling scans to the renderer entrypoints.
      // Scanning all of src/ includes backend-only code (src/node, src/cli), which can
      // pull in Node-only deps and break Vite's dep-scan (notably on Windows).
      entries: ["index.html", "terminal.html"],

      // Force re-optimize dependencies
      force: false,
    },
    assetsInclude: ["**/*.wasm"],
  };
});
