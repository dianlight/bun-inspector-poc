/**
 * Dev server for bun-inspector-poc.
 *
 * Uses Bun's fullstack dev server with HTML imports for native HMR.
 * The inspector plugin is registered in bunfig.toml [serve.static].
 *
 * Usage:
 *   bun dev
 */

import { serve } from "bun";
import indexHtml from "./index.html";

// ─── Spawn dev-inspector-mcp server ─────────────────────────────────────────
console.log("\n[dev] Starting bun-inspector-poc...\n");

const inspectorServer = Bun.spawn(
  [
    process.execPath,
    "x",
    "@mcpc-tech/unplugin-dev-inspector-mcp",
    "server",
    "--default-agent",
    "Opencode",
    "--visible-agents",
    "Opencode,Claude Code",
  ],
  {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  },
);

process.on("SIGINT", () => inspectorServer.kill());
process.on("SIGTERM", () => inspectorServer.kill());
await Bun.sleep(1500);

// ─── Start dev server with HMR ──────────────────────────────────────────────
const app = serve({
  routes: {
    "/": indexHtml,
  },

  development: {
    hmr: true,
    console: true,
  },

  fetch(req) {
    return new Response("Not Found", { status: 404 });
  },
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────
process.on("SIGINT", () => {
  console.log("\n[dev] Shutting down...");
  inspectorServer.kill();
  app.stop(true);
  process.exit(0);
});

// ─── Banner ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(54)}`);
console.log(`  App       → http://localhost:${app.port}`);
console.log(`  HMR       → native (via Bun dev server)`);
console.log(`  MCP       → http://localhost:6137/__mcp__/sse`);
console.log(`  Inspector → http://localhost:6137/__inspector__/sidebar`);
console.log(`  Console   → browser → terminal (via HMR WebSocket)`);
console.log(`${"─".repeat(54)}\n`);
console.log("  Ctrl+C to stop.\n");
