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
// In Bun, console.log does NOT go through process.stdout.write (unlike Node.js),
// so we hook console methods directly to capture output into the stdioLogs store.

let isIntercepting = false;

function initStdioInterceptor() {
  if (isIntercepting) return;
  isIntercepting = true;

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const origInfo = console.info;
  const origDebug = console.debug;

  const capture = (
    stream: "stdout" | "stderr",
    original: typeof console.log,
  ) =>
    (...args: unknown[]) => {
      try {
        const text = args
          .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
          .join(" ");
        addStdioLog(stream, text);
      } catch {
        // swallow – never break the user's console
      }
      return original.apply(console, args);
    };

  console.log = capture("stdout", origLog) as typeof console.log;
  console.info = capture("stdout", origInfo) as typeof console.info;
  console.debug = capture("stdout", origDebug) as typeof console.debug;
  console.warn = capture("stderr", origWarn) as typeof console.warn;
  console.error = capture("stderr", origError) as typeof console.error;
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
