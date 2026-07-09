/**
 * Unified dev server for bun-inspector-poc.
 *
 * A single `bun dev` command:
 *   1. Uses the bun-js-beforeparse native NAPI bridge to inline-transform
 *      .tsx/.jsx files with data-insp-path attributes inside Bun's bundler pipeline
 *   2. Spawns `bunx dev-inspector-server` as a background child process
 *   3. Starts Bun's fullstack dev server with HMR on port 3000
 *   4. Terminates the inspector server child when the dev server is killed
 *
 * NO pre-transform folder. NO separate watcher. The transform is inline.
 *
 * Usage:
 *   bun dev         (runs this file via package.json "dev" script)
 *   bun run dev.ts  (same)
 *
 * HOW THE NATIVE BRIDGE WORKS
 * ────────────────────────────
 * Bun 1.3.x JS bundler plugins cannot intercept .tsx/.jsx files via onLoad.
 * Only NAPI native plugins can use onBeforeParse for native file types.
 *
 * bun-js-beforeparse is a Rust NAPI module that provides a ThreadsafeFunction
 * bridge: Bun calls the native C hook on worker threads → the hook posts source
 * + path to the JS main thread via TSFN → the JS callback transforms → result
 * goes back through a sync channel to the worker → Bun uses the transformed source.
 *
 * From the user's perspective: jsBridge(asyncFn) returns the native descriptor
 * for build.onBeforeParse — no Rust code needed per project.
 */

import { serve } from "bun";
import { transformCode } from "@code-inspector/core";
import { jsBridge, releaseBridge } from "../bun-js-beforeparse/js/index.ts";
import homepage from "./index.html";

// ─── Step 1: spawn dev-inspector-server ────────────────────────────────────
//
// Uses process.execPath (the running Bun binary) — works regardless of PATH.
// The child inherits stdio so its logs appear inline in this terminal.

console.log("\n[dev] Starting bun-inspector-poc...\n");

const inspectorServer = Bun.spawn(
  [process.execPath, "x", "@mcpc-tech/unplugin-dev-inspector-mcp", "server"],
  {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  },
);

// Forward SIGINT / SIGTERM to the child so it shuts down cleanly
process.on("SIGINT", () => inspectorServer.kill());
process.on("SIGTERM", () => inspectorServer.kill());

// Wait briefly for the inspector server to initialize
await Bun.sleep(1500);

// ─── Step 2: create the onBeforeParse bridge ────────────────────────────────
//
// jsBridge() returns a descriptor for build.onBeforeParse().
// The transform is the same @code-inspector/core call used by the
// library's own Webpack/Turbopack loader (src/loader.ts).
//
// CONSTRAINT: transformCode() must resolve synchronously through the JS
// microtask queue (CPU-only Babel transform, no I/O). Do NOT use async I/O
// inside this callback — it would deadlock with the blocking worker thread.

const inspectBridge = jsBridge(async (source: string, path: string) => {
  if (path.includes("node_modules")) return source;
  try {
    return await transformCode({
      content: source,
      filePath: path,
      fileType: "jsx", // @code-inspector/core uses "jsx" for both .jsx and .tsx
      escapeTags: [],
      pathType: "absolute",
    });
  } catch {
    return source; // fall back to original on transform error
  }
});

// ─── Step 3: start Bun fullstack dev server with HMR ───────────────────────
//
// Registers the native onBeforeParse bridge as a plugin.
// Bun bundles index.html → src/index.tsx; the bridge intercepts all .tsx/.jsx
// files and injects data-insp-path="file:line:col:tag" attributes inline.
// HMR is Bun's own transparent hot reloading.

const app = serve({
  routes: {
    "/": homepage,
  },
  plugins: [
    {
      name: "dev-inspector-transform",
      setup(build) {
        build.onBeforeParse(
          { filter: /\.[jt]sx$/, namespace: "file" },
          inspectBridge,
        );
      },
    },
  ],
  development: {
    hmr: true,
    console: true, // echoes browser console to this terminal via HMR WebSocket
  },
  port: 3000,
});

// ─── Banner ────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(54)}`);
console.log(`  App     → http://localhost:${app.port}`);
console.log(`  MCP     → http://localhost:6137/__mcp__/sse`);
console.log(`  Inspector → http://localhost:6137/__inspector__/sidebar`);
console.log(`${"─".repeat(54)}\n`);
console.log("  HMR + inline onBeforeParse transform active. Ctrl+C to stop.\n");

// Note: releaseBridge(inspectBridge) would be called on shutdown, but since
// Bun.serve() keeps the event loop alive anyway, it's not needed here.
// The bridge only needs releasing in Bun.build() one-shot scripts.
