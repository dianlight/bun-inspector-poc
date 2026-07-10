/**
 * Simplified dev server for bun-inspector-poc.
 *
 * A single `bun dev` command:
 *   1. Spawns the dev-inspector-mcp server as a background child process
 *   2. Uses bun-js-beforeparse NAPI bridge + @code-inspector/core to
 *      transform .tsx/.jsx files with data-insp-path attributes via onBeforeParse
 *   3. Bundles with Bun.build({ development: true, sourcemap: "inline" })
 *   4. Serves with HMR via WebSocket — auto-rebuilds on file changes
 *   5. Terminates cleanly on Ctrl+C
 *
 * Usage:
 *   bun dev
 *   bun run dev.ts
 */

import { serve } from "bun";
import { existsSync, mkdirSync, watch } from "fs";
import { join } from "path";
import { transformCode } from "@code-inspector/core";
import { jsBridge, releaseBridge } from "bun-js-beforeparse";

// ─── Config ──────────────────────────────────────────────────────────────────
const PROJECT_ROOT = import.meta.dir;
const SRC_DIR = join(PROJECT_ROOT, "src");
const OUT_DIR = join(PROJECT_ROOT, "_dev");
const DEFAULT_AGENT = "Opencode";
const VISIBLE_AGENTS = "Opencode,Claude Code";

// ─── Step 1: Spawn dev-inspector-mcp server ──────────────────────────────────
console.log("\n[dev] Starting bun-inspector-poc...\n");

const inspectorServer = Bun.spawn(
  [
    process.execPath,
    "x",
    "@mcpc-tech/unplugin-dev-inspector-mcp",
    "server",
    "--default-agent",
    DEFAULT_AGENT,
    "--visible-agents",
    VISIBLE_AGENTS,
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

// ─── Step 2: Create the onBeforeParse bridge ─────────────────────────────────
const inspectBridge = jsBridge(async (source: string, path: string) => {
  if (path.includes("node_modules")) return source;
  try {
    return await transformCode({
      content: source,
      filePath: path,
      fileType: "jsx",
      escapeTags: [],
      pathType: "absolute",
    });
  } catch {
    return source;
  }
});

// ─── Step 3: Bundle ──────────────────────────────────────────────────────────
async function bundle(): Promise<boolean> {
  mkdirSync(OUT_DIR, { recursive: true });

  const entryPath = join(SRC_DIR, "index.tsx");
  if (!existsSync(entryPath)) {
    console.warn("[dev] No entrypoint at src/index.tsx — skipping build");
    return false;
  }

  const result = await Bun.build({
    entrypoints: [entryPath],
    outdir: OUT_DIR,
    naming: "[name].[ext]",
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
    // @ts-expect-error — development mode is valid at runtime (Bun ≥1.3)
    development: true,
    sourcemap: "inline" as const,
  });

  if (!result.success) {
    for (const log of result.logs || []) {
      if (log.level === "error") console.error("[dev] Build error:", log);
    }
    return false;
  }

  // Write index.html with HMR client
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Bun Inspector POC</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./index.js"></script>
    <script>
      // HMR client — connects to WebSocket and reloads on updates
      (function connectHMR() {
        const ws = new WebSocket("ws://localhost:3000/__hmr__");
        ws.onmessage = (e) => {
          const data = JSON.parse(e.data);
          if (data.type === "update") {
            console.log("[HMR] Rebuilding...");
            location.reload();
          }
        };
        ws.onclose = () => setTimeout(connectHMR, 1000);
        ws.onerror = () => ws.close();
      })();
    </script>
  </body>
</html>`;

  await Bun.write(join(OUT_DIR, "index.html"), html);
  console.log(`[dev] Build complete — ${result.outputs?.length || 0} output(s)`);
  return true;
}

await bundle();

// ─── Step 4: Start server with HMR ──────────────────────────────────────────
const app = serve({
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for HMR
    if (url.pathname === "/__hmr__") {
      if (server.upgrade(req)) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // Serve static files from _dev/
    const relativePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = join(OUT_DIR, relativePath);

    if (existsSync(filePath)) {
      return new Response(Bun.file(filePath));
    }

    // Fallback to index.html for SPA routes
    const indexPath = join(OUT_DIR, "index.html");
    if (existsSync(indexPath)) {
      return new Response(Bun.file(indexPath));
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.subscribe("hmr");
    },
    message() {},
    close() {},
  },
  port: 3000,
});

// ─── Step 5: Watch src/ for changes → auto-rebuild + HMR ────────────────────
let rebuildTimer: Timer | null = null;

async function rebuild(): Promise<void> {
  console.log("\n[dev] Rebuilding...");
  const success = await bundle();
  if (success) {
    console.log("[dev] Rebuild complete");
    app.publish("hmr", JSON.stringify({ type: "update" }));
  }
}

if (existsSync(SRC_DIR)) {
  watch(SRC_DIR, { recursive: true }, (_event, filename) => {
    if (!filename || !/\.(tsx?|jsx?)$/i.test(filename)) return;
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => rebuild().catch(console.error), 300);
  });
}

// ─── Graceful shutdown ───────────────────────────────────────────────────────
function shutdown() {
  console.log("\n[dev] Shutting down...");
  inspectorServer.kill();
  releaseBridge(inspectBridge);
  app.stop(true);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Banner ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(54)}`);
console.log(`  App       → http://localhost:${app.port}`);
console.log(`  HMR       → ws://localhost:${app.port}/__hmr__`);
console.log(`  MCP       → http://localhost:6137/__mcp__/sse`);
console.log(`  Inspector → http://localhost:6137/__inspector__/sidebar`);
console.log(`${"─".repeat(54)}\n`);
console.log("  Ctrl+C to stop.\n");
