/**
 * Unified dev server for bun-inspector-poc.
 *
 * A single `bun dev` command:
 *   1. Pre-transforms src/ → _transformed/src/ (injects data-insp-path attrs)
 *   2. Spawns `bunx dev-inspector-server` as a background child process
 *   3. Starts Bun's fullstack dev server with HMR on port 3000
 *   4. Watches src/ for changes and re-transforms on save
 *   5. Terminates the inspector server child when the dev server is killed
 *
 * Usage:
 *   bun dev         (runs this file via package.json "dev" script)
 *   bun run dev.ts  (same)
 *
 * WHY THERE'S NO onLoad PLUGIN
 * ────────────────────────────
 * Bun 1.3.x JS bundler plugins do NOT fire onLoad/onResolve for native file
 * types (.tsx, .jsx) inside Bun.build(). Only NAPI (C/Zig/Rust) plugins can
 * intercept those via the onBeforeParse hook. So we pre-transform sources to a
 * _transformed/ directory before Bun bundles them. Bun bundles the augmented
 * sources normally — the data-insp-path JSX attributes survive Bun's own
 * JSX compilation intact.
 *
 * RUNTIME PLUGIN NOTE
 * ────────────────────
 * Bun.plugin() onLoad DOES fire in the runtime module loader (bun run).
 * It just doesn't fire in Bun.build() / Bun.serve(). The pre-transform
 * produces identical output, so the end result is the same.
 */

import { serve } from "bun";
import { watchTransforms, transformAll } from "./scripts/pre-transform";
import homepage from "./_transformed/index.html";

// ─── Step 1: pre-transform sources ─────────────────────────────────────────

console.log("\n[dev] Starting bun-inspector-poc...\n");
const transformedFiles = await transformAll();
console.log("");

// ─── Step 2: spawn dev-inspector-server ────────────────────────────────────
//
// Uses process.execPath (the running Bun binary) so this works regardless of
// whether the user has `bun` on their PATH. `bun x <pkg>` is the bunx command.
// The child inherits stdio so its logs appear inline in this terminal.

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
const cleanup = () => {
  inspectorServer.kill();
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// Wait briefly for the inspector server to initialize before starting the app
// (gives it time to print its banner and write MCP configs)
await Bun.sleep(1500);

// ─── Step 3: start Bun fullstack dev server with HMR ───────────────────────
//
// Serves _transformed/index.html whose <script> points at the pre-augmented
// sources in _transformed/src/. Bun bundles those normally.
// HMR is Bun's own transparent hot reloading — no import.meta.hot needed
// in the inspector client (it's guarded by window.__DEV_INSPECTOR_LOADED__).

const app = serve({
  routes: {
    "/": homepage,
  },
  development: {
    hmr: true,
    // Echoes browser console.log calls to this terminal over the HMR WebSocket.
    // The inspector also captures console via its own HTTP POST interceptor.
    console: true,
  },
  port: 3000,
});

// ─── Step 4: watch src/ for changes and re-transform ───────────────────────
//
// When a source file changes: re-transform it → Bun HMR picks up the new file
// in _transformed/src/ and hot-reloads the browser automatically.

watchTransforms(transformedFiles);

// ─── Banner ────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(54)}`);
console.log(`  App     → http://localhost:${app.port}`);
console.log(`  MCP     → http://localhost:6137/__mcp__/sse`);
console.log(`  Inspector → http://localhost:6137/__inspector__/sidebar`);
console.log(`${"─".repeat(54)}\n`);
console.log("  HMR + file watching active. Ctrl+C to stop all.\n");
