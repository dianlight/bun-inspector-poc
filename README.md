# dev-inspector-mcp + Bun Fullstack Dev Server — POC

This project demonstrates how to integrate
[`@mcpc-tech/unplugin-dev-inspector-mcp`](https://github.com/mcpc-tech/dev-inspector-mcp)
into a **React 19** app that uses
[Bun's native fullstack dev server](https://bun.com/docs/bundler/fullstack) with HMR.

**No changes to the library.** Everything lives in userland.

---

## Quick start

```sh
bun install
bun dev
```

Then open <http://localhost:3000> and use the floating inspector bar (bottom-right)
to click any element and see its accurate source location (`file:line:col`).

The MCP server starts automatically at <http://localhost:6137/__mcp__/sse> and is
ready for AI agent connections (Claude Code, Cursor, VS Code MCP, etc.).

---

## How it works

```
┌─────────────────────────────────────────────────────────────────┐
│  bun dev   (single command, runs dev.ts)                        │
│                                                                 │
│  ① Bun.spawn → dev-inspector-server (port 6137)                │
│     serves inspector UI, MCP SSE endpoint, ACP chat            │
│                                                                 │
│  ② jsBridge(transformCode) → onBeforeParse NAPI plugin         │
│     injects data-insp-path="file:line:col:tag" inline,          │
│     inside Bun's bundler pipeline (no _transformed/ folder)     │
│                                                                 │
│  ③ Bun.serve(index.html, { plugins, hmr: true })               │
│     Bun bundles src/ normally, transform runs per-file          │
└─────────────────────────────────────────────────────────────────┘

Browser:
  <DevInspector/> in src/index.tsx
    → loads http://localhost:6137/__inspector__/inspector.js
    → connects SSE to http://localhost:6137/__mcp__/sse
    → click element → reads data-insp-path attr → resolves file:line:col
```

### How the inline transform works

Bun 1.3.x JS bundler plugins (`onLoad`/`onResolve`) **cannot** intercept native file
types (`.tsx`, `.jsx`). Only NAPI native modules can, via the `onBeforeParse` hook.

[`bun-js-beforeparse`](../bun-js-beforeparse/) is a Rust NAPI module that bridges this
gap: it exposes a `jsBridge(fn)` function that wraps any TypeScript callback and
registers it as a real `onBeforeParse` native hook. No Rust code is needed per project.

```
Bun worker thread (native)           JS main thread
──────────────────────────           ──────────────
bun_js_bridge_dispatch()             TSFN callback fires
  read source (zero-copy)              calls transformCode(source, path)
  create SyncChannel(0)                result sent through channel
  tsfn.call_with_return_value() ──────────────────────────────────────
  blocks on rx.recv()  ←─────────────── tx.send(transformed)
  set_output_source_code()
```

`dev.ts` registers it as:

```ts
const inspectBridge = jsBridge(async (source, path) => {
  return await transformCode({ content: source, filePath: path, fileType: "jsx", ... });
});

Bun.serve({
  plugins: [{
    name: "dev-inspector-transform",
    setup(build) {
      build.onBeforeParse({ filter: /\.[jt]sx$/ }, inspectBridge);
    },
  }],
  ...
});
```

`transformCode()` (from `@code-inspector/core`) is a CPU-only Babel transform — safe to
`await` inside the bridge because its Promise resolves through microtasks without
yielding the event loop.

### Why no import.meta.hot / HMR API calls?

The library has zero uses of `import.meta.hot` or `module.hot`. The inspector UI is
injected via a `<script>` tag loaded from port 6137 — entirely outside Bun's HMR graph.
Injection is idempotent (guarded by `window.__DEV_INSPECTOR_LOADED__` and
`customElements.get()`), so Bun's HMR never double-mounts the inspector.

---

## Project structure

```
bun-inspector-poc/
├── dev.ts                  ← single dev command: spawns inspector server +
│                              registers NAPI bridge + starts Bun.serve()
├── index.html              ← HTML entry point (served directly — no generated copy)
├── src/
│   ├── index.tsx           ← app entry; mounts <DevInspector host="localhost" port={6137}/>
│   └── App.tsx             ← demo React components
├── inspector-plugin.ts     ← Bun runtime onLoad plugin (bun run context only, not bundler)
├── bunfig.toml             ← plugin stanza commented out (see limitations below)
└── package.json
```

**Dependencies on the sibling package:**

```ts
// dev.ts imports from the local bun-js-beforeparse package
import { jsBridge } from "../bun-js-beforeparse/js/index.ts";
```

---

## The three moving parts explained

### 1. JSX source transform — via `bun-js-beforeparse` + `@code-inspector/core`

`transformCode()` injects `data-insp-path` attributes into every JSX element:

```tsx
// Input (src/App.tsx)
<button onClick={...}>Increment</button>

// Output (as seen by Bun's bundler, inline — no files written)
<button onClick={...} data-insp-path="/abs/path/src/App.tsx:10:7:button">
  Increment
</button>
```

The client reads these at runtime in `sourceDetector.ts`. When you click an element in
the inspector, it walks the DOM reading `data-insp-path` and reports `file:line:col` back
to the MCP server, which an AI agent uses to open the exact line in your editor.

**Fallback without the transform:** the inspector still works via React Fiber detection —
it finds the owning component by name. Less precise (component name, not line number), but
requires zero build configuration.

### 2. UI injection — `src/index.tsx`

```tsx
import { DevInspector } from "@mcpc-tech/unplugin-dev-inspector-mcp/next";

root.render(
  <>
    <App />
    <DevInspector host="localhost" port={6137} />
  </>,
);
```

`DevInspector` (from the library's `/next` export, `src/next.tsx`) is a plain React 19
component that runs in a `useEffect`:

1. Sets `window.__DEV_INSPECTOR_CONFIG__` (host/port, read by the inspector client)
2. Appends `<dev-inspector-mcp>` custom element to `document.body`
3. Injects `<script type="module" src="http://localhost:6137/__inspector__/inspector.js">`

It has no Vite or Next.js dependency — it is bundler-agnostic.

### 3. Standalone server — auto-started by `dev.ts`

`dev.ts` spawns the inspector server at startup:

```ts
const inspectorServer = Bun.spawn(
  [process.execPath, "x", "@mcpc-tech/unplugin-dev-inspector-mcp", "server"],
  { stdout: "inherit", stderr: "inherit", env: process.env },
);
```

`process.execPath` is the running Bun binary — more reliable than relying on `bunx`
being on PATH. The server starts on port 6137 (auto-increments if taken) and provides:

| Endpoint | Purpose |
|---|---|
| `GET /ping` | Health check |
| `GET /__inspector__/inspector.js` | Inspector UI bundle (browser fetches this) |
| `GET /__inspector__/sidebar` | Standalone sidebar HTML page |
| `GET /__mcp__/sse` | MCP SSE transport (AI agents connect here) |
| `POST /__mcp__` | MCP Streamable HTTP transport |
| `POST /api/acp/chat` | AI agent chat (Vercel AI SDK streaming) |
| `POST /__inspector__/log` | Receives console + network from browser |

The server also auto-updates `.cursor/mcp.json` and `.vscode/mcp.json` so editors
pick up the MCP URL without manual configuration.

---

## Connecting an AI agent

After `bun dev`, the MCP server URL is printed to the console:

```
MCP → http://localhost:6137/__mcp__/sse
```

### Claude Code

```sh
claude mcp add dev-inspector http://localhost:6137/__mcp__/sse
```

### Cursor / VS Code

The server auto-writes the URL into `.cursor/mcp.json` and `.vscode/mcp.json`.
Restart Cursor/VS Code to pick it up, or point manually:

```json
{
  "mcpServers": {
    "dev-inspector": {
      "url": "http://localhost:6137/__mcp__/sse"
    }
  }
}
```

### Available MCP tools

| Tool | What it does |
|---|---|
| `capture_element_context` | Click an element → returns source file, component tree, styles, screenshot |
| `capture_area_context` | Rubber-band select a region → returns all elements in it |
| `list_inspections` | List captured inspection results |
| `execute_page_script` | Run arbitrary JS in the app's browser context |
| `get_page_info` | App URL, title, viewport, React version |
| `get_console_logs` | Browser console output |
| `get_network_requests` | Intercepted XHR/fetch calls with request/response bodies |
| `chrome_*` tools | Full Chrome DevTools Protocol (screenshot, navigate, evaluate, etc.) |

---

## Bun bundler plugin notes

### `onLoad` does not fire for native file types

JS plugins registered with `Bun.plugin()` or `Bun.build({ plugins })` do **not** fire
`onLoad`/`onResolve` for `.tsx`, `.jsx`, `.ts`, `.js` — only for custom extensions.
`inspector-plugin.ts` in this repo is a correct implementation, but it only works in the
**Bun runtime module loader** (`bun run`), not inside the bundler used by `Bun.serve()`.

`bun-js-beforeparse` solves this by providing a native `onBeforeParse` hook that does
intercept these file types, and bridging it to any JS callback via a ThreadsafeFunction.

### `bunfig.toml` `[serve.static] plugins`

The `bunfig.toml` stanza is commented out. It requires a **default export** module, and
has the same native-type limitation as JS `onLoad`. The NAPI bridge registered directly
in `dev.ts` via `Bun.serve({ plugins })` is the working solution.

---

## What first-class library support would look like

If this pattern were upstreamed to `@mcpc-tech/unplugin-dev-inspector-mcp`, it would add:

1. A `bunDevInspector(options)` export bundling `jsBridge(transformCode)` +
   `startStandaloneServer()` — mirrors the existing `turbopackDevInspector()` pattern
   in `src/turbopack.ts:134`.

2. `"bun"` added to `BundlerType` in `src/commands/setup/types.ts` and a new
   `src/commands/setup/frameworks/bun.ts` — so `npx dev-inspector setup` auto-wires a
   Bun project's config.

For now, this POC is the complete working recipe.

---

## Troubleshooting

**Inspector bar doesn't appear**
- Check port 6137 is free: `lsof -i :6137`
- Verify the server started: `curl http://localhost:6137/ping` → `pong`
- Check browser console for errors loading `/__inspector__/inspector.js`

**Click-to-source shows component name, not file:line**
- Verify the NAPI bridge is running: the terminal should show transform calls during startup
- Check `bun-js-beforeparse.linux-x64-gnu.node` (or the correct platform variant) exists in `../bun-js-beforeparse/`
- Rebuild the native module if needed: `cd ../bun-js-beforeparse && bun run build:debug`

**MCP connection refused in Claude Code / Cursor**
- The server URL is `http://localhost:6137/__mcp__/sse` (SSE transport).
- Some editors require restarting after `.cursor/mcp.json` is written.
- Verify: `curl -N http://localhost:6137/__mcp__/sse` — should hold the connection open.

**Port 6137 already in use**
- The server auto-increments: check the console banner for the actual port.
- Set a custom port: `DEV_INSPECTOR_PORT=6200 bun dev`

**Process hangs after a one-shot `Bun.build()` call**
- Call `releaseBridge(descriptor)` after the build to unref the TSFN. Not needed for
  `Bun.serve()` since the server itself keeps the event loop alive.
