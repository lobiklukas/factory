// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Vite configuration runs in Node and requires a native filesystem path.
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-vite-plugin";
import { defineConfig } from "vite";
import { devPort } from "./vite-port";

// The repository-root `.env` is the one file every app reads (`apps/api` and `apps/cli` load it with
// `--env-file=../../.env`), so a `VITE_SERVER_URL` set there reaches the dashboard too. Only
// `VITE_`-prefixed values are exposed to the browser bundle; a key beside them stays server-side.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [
    tanstackRouter({
      // The dashboard's own components live under src/, so routes do too and
      // routeTree.gen.ts lands beside them.
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      autoCodeSplitting: false,
    }),
    react(),
    tailwindcss(),
  ],
  envDir: repoRoot,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // VITE_PORT lets a verification run use an isolated port instead of competing
    // for 3000 with whatever else is already running locally. See
    // .pi/skills/verify-web/SKILL.md. The shell wins over the root `.env`.
    // oxlint-disable-next-line effecttsgo/process-env -- Vite's dev server reads its config in Node, before Effect exists.
    port: devPort(mode, repoRoot, process.env),
    strictPort: true,
    host: "127.0.0.1",
  },
}));
