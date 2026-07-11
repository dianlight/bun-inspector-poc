/**
 * Dev server for bun-inspector-poc.
 *
 * Uses Bun's fullstack dev server with HTML imports for native HMR.
 * Instead of spawning the CLI server (which doesn't init stdio interception),
 * we set up the inspector server in-process so process.stdout/stderr are
 * properly captured into the stdioLogs store.
 *
 * Usage:
 *   bun dev
 */

// @ts-ignore — internal dist imports (no public API for these)
import path from "node:path";
import { serve } from "bun";
import indexHtml from "./index.html";

const configUpdater = await import(
  path.join(
    process.cwd(),
    "node_modules/@mcpc-tech/unplugin-dev-inspector-mcp/dist/config-updater.js",
  ),
);
const {
  a: addStdioLog,
  i: setupMcpMiddleware,
  n: setupAcpMiddleware,
  o: getDefaultPort,
  r: setupInspectorMiddleware,
  s: startStandaloneServer,
  t: updateMcpConfigs,
} = configUpdater;

// ─── Stdio interceptor ────────────────────────────────────────────────────────
// Mirrors the logic in src/utils/stdio-interceptor.ts (unplugin) but runs
// in-process so addStdioLog writes to the same array GET /__inspector__/stdio reads.

let isIntercepting = false;

function initStdioInterceptor() {
  if (isIntercepting) return;
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

  const toText = (chunk: unknown): string =>
    typeof chunk === "string" ? chunk : String(chunk);

  const wrapWrite =
    (stream: "stdout" | "stderr", original: typeof origStdout) =>
    (chunk: any, ...args: any[]) => {
      try {
        addStdioLog(stream, toText(chunk));
      } catch {
        // swallow – never break the user's console
      }
      return original(chunk, ...args);
    };

  process.stdout.write = wrapWrite("stdout", origStdout) as any;
  process.stderr.write = wrapWrite("stderr", origStderr) as any;
  isIntercepting = true;
}

// ─── Start inspector server in-process ────────────────────────────────────────
console.log("\n[dev] Starting bun-inspector-poc...\n");

const { server: inspectorServer, host: inspectorHost, port: inspectorPort } =
  await startStandaloneServer({
    port: getDefaultPort(),
    host: "localhost",
  });

const serverContext = {
  host: inspectorHost,
  port: inspectorPort,
  disableChrome: true,               // no Chrome/CDP in Bun — use native tools
};

await setupMcpMiddleware(inspectorServer, serverContext);
setupAcpMiddleware(inspectorServer, serverContext, {});
setupInspectorMiddleware(inspectorServer, { disableChrome: true });

// Hook stdout/stderr NOW so the inspector server captures everything
initStdioInterceptor();

const displayHost = inspectorHost === "0.0.0.0" ? "localhost" : inspectorHost;
const mcpUrl = `http://${displayHost}:${inspectorPort}/__mcp__/sse`;

await updateMcpConfigs(process.cwd(), mcpUrl, {});

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
    console.error("Nor Found",req);
    return new Response("Not Found", { status: 404 });
  },
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────
process.on("SIGINT", () => {
  console.log("\n[dev] Shutting down...");
  app.stop(true);
  process.exit(0);
});
process.on("SIGTERM", () => {
  app.stop(true);
  process.exit(0);
});

// ─── Banner ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(54)}`);
console.log(`  App       → http://localhost:${app.port}`);
console.log(`  HMR       → native (via Bun dev server)`);
console.log(`  MCP       → ${mcpUrl}`);
console.log(`  Inspector → http://${displayHost}:${inspectorPort}/__inspector__/sidebar`);
console.log(`  Console   → browser → terminal (via HMR WebSocket)`);
console.log(`${"─".repeat(54)}\n`);
console.log("  Ctrl+C to stop.\n");
