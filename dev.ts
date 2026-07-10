/**
 * Unified dev server for bun-inspector-poc.
 *
 * A single `bun dev` command:
 *   1. Spawns the dev-inspector-mcp server as a background child process
 *   2. Uses bun-js-beforeparse v0.2.0 NAPI bridge + @code-inspector/core to
 *      transform .tsx/.jsx files with data-insp-path attributes via onBeforeParse
 *      INSIDE Bun's bundler pipeline (no pre-transform to disk)
 *   3. Bundles the source with Bun.build({ development: true, sourcemap: "inline" })
 *      for inline sourcemaps and React DevTools compatibility
 *   4. Serves the bundled output statically on port 3000
 *   5. Watches src/ for changes and rebuilds automatically
 *   6. Terminates the inspector server and dev server cleanly on Ctrl+C
 *
 * WHY Bun.build() INSTEAD OF Bun.serve({ plugins })?
 * ──────────────────────────────────────────────────
 * Bun 1.3.x's serve() silently ignores plugins — setup() is never called.
 * However, Bun.build() fully supports plugins with onBeforeParse, so we build
 * first, then serve the output statically.  The trade-off is no true HMR, but
 * we have a file watcher + manual browser refresh.
 *
 * Usage:
 *   bun dev         (runs this file via package.json "dev" script)
 *   bun run dev.ts  (same)
 */

import { serve } from "bun";
import { existsSync, mkdirSync, watch } from "fs";
import { join } from "path";
import { transformCode } from "@code-inspector/core";
import { jsBridge, releaseBridge } from "bun-js-beforeparse";

// ─── Paths ─────────────────────────────────────────────────────────────────
const PROJECT_ROOT = import.meta.dir;
const SRC_DIR = join(PROJECT_ROOT, "src");
const OUT_DIR = join(PROJECT_ROOT, "_dev"); // bundled output

// ─── Step 1: spawn dev-inspector-server ────────────────────────────────────

console.log("\n[dev] Starting bun-inspector-poc...\n");

// ─── Agent configuration ────────────────────────────────────────────────
// Available agents: "Claude Code", "Codex CLI", "Opencode", "Gemini CLI",
// "Goose", "Cursor Agent", "CodeBuddy Code", "Kimi CLI", "Droid"
//
// Prerequisites:
//   Opencode    → curl -fsSL https://opencode.ai/install | bash
//   Claude Code → @zed-industries/claude-code-acp (installed as devDep)
//   Codex CLI   → @zed-industries/codex-acp (optionalDep, installed)
const DEFAULT_AGENT = "Opencode";
const VISIBLE_AGENTS = "Opencode,Claude Code";

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

// Forward SIGINT / SIGTERM to the child so it shuts down cleanly
process.on("SIGINT", () => inspectorServer.kill());
process.on("SIGTERM", () => inspectorServer.kill());

// Wait briefly for the inspector server to initialize
await Bun.sleep(1500);

// ─── Step 2: create the onBeforeParse bridge ────────────────────────────────
//
// jsBridge() wraps an async transform function as a NAPI native plugin descriptor
// for build.onBeforeParse().  bun-js-beforeparse v0.2.0 properly awaits Promises
// returned by the callback, so @code-inspector/core's transformCode() works.

const inspectBridge = jsBridge(async (source: string, path: string) => {
  // Skip node_modules — they don't need data-insp-path attributes
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

// ─── Step 3: bundle with Bun.build() + onBeforeParse bridge ───────────────
//
// Uses Bun.build() with the native bridge plugin to intercept .tsx/.jsx files
// during bundling.  development:true + sourcemap:inline gives us inline
// sourcemaps that map back to the original source files.

async function bundle(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const entryPath = join(SRC_DIR, "index.tsx");
  if (!existsSync(entryPath)) {
    console.warn("[dev] No entrypoint at src/index.tsx — skipping build");
    return;
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
    // No external — bundle everything inline so the browser can load
    // the output directly via <script type="module" src="./index.js">
    // without needing an importmap or serving node_modules.
  });

  if (!result.success) {
    for (const log of result.logs || []) {
      if (log.level === "error") console.error(`[dev] Build error:`, log);
    }
    return;
  }

  // Write an index.html that loads the bundled JS
  const htmlContent = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Bun Inspector POC</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./index.js"></script>
  </body>
</html>`;
  await Bun.write(join(OUT_DIR, "index.html"), htmlContent);

  console.log(`[dev] Bundle complete — ${result.outputs?.length || 0} output(s)`);
}

// ─── Initial build ─────────────────────────────────────────────────────────

await bundle();

// ─── Step 4: start Bun dev server (static file server) ─────────────────────
//
// Serves the pre-built output from _dev/.  Since Bun.serve() doesn't support
// plugins in 1.3.x, we use static file serving + manual rebuilds.

const app = serve({
  fetch(req) {
    const url = new URL(req.url);
    // Map root → index.html
    const relativePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = join(OUT_DIR, relativePath);

    // Serve static files from _dev/
    if (existsSync(filePath)) {
      return new Response(Bun.file(filePath));
    }

    // Fallback: serve index.html for SPA-like routes (React Router, etc.)
    const indexPath = join(OUT_DIR, "index.html");
    if (existsSync(indexPath)) {
      return new Response(Bun.file(indexPath));
    }

    return new Response("Not found", { status: 404 });
  },
  port: 3000,
});

// ─── Step 5: watch src/ for changes → auto-rebuild ────────────────────────

let rebuildTimer: Timer | null = null;

async function rebuild(): Promise<void> {
  console.log("\n[dev] Rebuilding…");
  await bundle();
  console.log("[dev] Rebuild complete — refresh the browser\n");
}

if (existsSync(SRC_DIR)) {
  watch(SRC_DIR, { recursive: true }, (_event, filename) => {
    if (!filename || !/\.(tsx?|jsx?)$/i.test(filename)) return;
    // Debounce rapid changes (e.g. editor save → multiple events)
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuild().catch(console.error);
    }, 300);
  });
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────

function shutdown() {
  console.log("\n[dev] Shutting down…");
  inspectorServer.kill();
  releaseBridge(inspectBridge); // allow the process to exit cleanly
  app.stop(true);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Banner ────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(54)}`);
console.log(`  App      → http://localhost:${app.port}`);
console.log(`  Rebuild  → auto on src/ changes (refresh browser)`);
console.log(`  MCP      → http://localhost:6137/__mcp__/sse`);
console.log(`  Inspector → http://localhost:6137/__inspector__/sidebar`);
console.log(`  Dev      → inline sourcemaps + data-insp-path (onBeforeParse)`);
console.log(`${"─".repeat(54)}\n`);
console.log("  Ctrl+C to stop.\n");
