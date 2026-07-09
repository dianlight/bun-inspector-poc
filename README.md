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
┌─────────────────────────────────────────────────────────────┐
│  bun dev   (single command, runs dev.ts)                    │
│                                                             │
│  ① pre-transform src/ → _transformed/src/                  │
│     injects data-insp-path="file:line:col:tag" via          │
│     @code-inspector/core (same as Vite/Turbopack path)      │
│                                                             │
│  ② Bun.spawn → dev-inspector-server (port 6137)            │
│     serves inspector UI, MCP SSE endpoint, ACP chat        │
│                                                             │
│  ③ Bun.serve(_transformed/index.html, { hmr: true })       │
│     Bun bundles _transformed/src/ normally (port 3000)     │
│                                                             │
│  ④ watchFile — re-transforms src/ changes on save          │
│     Bun HMR picks up _transformed/src/ automatically       │
└─────────────────────────────────────────────────────────────┘

Browser:
  <DevInspector/> in src/index.tsx
    → loads http://localhost:6137/__inspector__/inspector.js
    → connects SSE to http://localhost:6137/__mcp__/sse
    → click element → reads data-insp-path attr → resolves file:line:col
```

### Why a pre-transform step instead of an onLoad plugin?

Bun 1.3.x JS bundler plugins (`Bun.build`) do **not** fire `onLoad`/`onResolve` for
native file types (`.tsx`, `.jsx`, `.ts`, `.js`). That hook is only triggered for
custom file extensions or virtual modules. Intercepting native types requires a **NAPI
(C/Zig/Rust) native plugin** via `onBeforeParse` — not available from pure JavaScript.

> **Note:** `Bun.plugin()` *does* fire `onLoad` in the **runtime module loader**
> (`bun run`), just not in `Bun.build()` / `Bun.serve()`. So the pre-transform
> produces the exact same result.

The pre-transform is a one-time step at startup, then a lightweight file-watcher. It
does not add a separate terminal or manual command — `dev.ts` orchestrates everything.

### Why no import.meta.hot / HMR API calls?

The library doesn't use `import.meta.hot` or `module.hot` anywhere. The inspector UI
is injected via a `<script>` tag loaded from port 6137 — outside Bun's HMR graph
entirely. Injection is idempotent (guarded by `window.__DEV_INSPECTOR_LOADED__` and
`customElements.get()`), so Bun's HMR never double-mounts.

---

## Project structure

```
bun-inspector-poc/
├── dev.ts                      ← single dev command (orchestrator)
├── index.html                  ← original HTML (not served in dev, kept for reference)
├── src/
│   ├── index.tsx               ← app entry; mounts <DevInspector/>
│   └── App.tsx                 ← demo React components
├── _transformed/               ← generated; gitignore this
│   ├── index.html              ← HTML served by Bun (script points at _transformed/src/)
│   └── src/                    ← JSX/TSX with data-insp-path attrs injected
├── scripts/
│   └── pre-transform.ts        ← transform library + standalone CLI
├── inspector-plugin.ts         ← Bun onLoad plugin (for runtime use; not Bun.build)
├── inspector-plugin-default.ts ← default-export wrapper (for bunfig.toml plugins)
├── bunfig.toml                 ← commented out; see Bun plugin limitations below
└── package.json
```

---

## The three moving parts explained

### 1. JSX source transform — `scripts/pre-transform.ts`

Uses `@code-inspector/core`'s `transformCode()` — the same function used by the
library's own Webpack/Turbopack loader (`loader.ts`). It injects attributes like:

```tsx
// Input
<button onClick={...}>Increment</button>

// Output
<button onClick={...} data-insp-path="/abs/path/src/App.tsx:10:7:button">
  Increment
</button>
```

The client reads these at runtime in `sourceDetector.ts`. When you click an element
in the inspector, it walks up the DOM reading `data-insp-path` and reports the exact
`file:line:col` back to the MCP server, which an AI agent then uses to open the file.

**Fallback without the transform:** if you skip the pre-transform, the inspector still
works via React Fiber detection — it finds the owning component by name from the React
internal fiber tree. Less precise (component name, not line), but zero build changes.

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

`DevInspector` (from the `/next` export, `src/next.tsx` in the library) is a plain
React 19 component that runs in a `useEffect`:

1. Sets `window.__DEV_INSPECTOR_CONFIG__` (host/port, read by the inspector client)
2. Appends `<dev-inspector-mcp>` custom element to `document.body`
3. Injects `<script type="module" src="http://localhost:6137/__inspector__/inspector.js">`

It does **not** import from Vite or Next.js — it's a bundler-agnostic component.

### 3. Standalone server — auto-started by `dev.ts`

`dev.ts` spawns the standalone inspector server via:

```ts
const inspectorServer = Bun.spawn(
  [process.execPath, "x", "@mcpc-tech/unplugin-dev-inspector-mcp", "server"],
  { stdout: "inherit", stderr: "inherit", env: process.env },
);
```

`process.execPath` is the current Bun binary path — more reliable than relying on
`bunx` being on PATH. The server starts on port 6137 (auto-increments if taken) and
provides:

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

## Bun bundler plugin limitations (documented here for reference)

> **TL;DR:** You don't need to do anything — `dev.ts` handles it. This section
> explains *why* the approach works the way it does.

### Why `inspector-plugin.ts` is not used in `Bun.serve()`

`inspector-plugin.ts` is a correct Bun `BunPlugin` implementation that would intercept
`.tsx`/`.jsx` files and call `transformCode()`. It works perfectly in `bun run`
(the runtime module loader). But `Bun.build()` and `Bun.serve()` — which drive the
browser bundle — do **not** fire `onLoad`/`onResolve` for native file types.

This was verified empirically: even with a `console.log` inside the `onLoad` callback,
no output appeared during `Bun.build({ entrypoints: ['./src/App.tsx'] })`.

The root cause: Bun's built-in loaders for `.tsx`, `.jsx`, `.ts`, `.js` bypass the JS
plugin hook entirely. Only the low-level `onBeforeParse` hook (NAPI modules only) can
intercept them. This is documented in Bun 1.2 release notes as a native-only feature.

### `bunfig.toml` `[serve.static] plugins`

This feature also requires a **default export** (not a named export), and has the same
limitation: it doesn't intercept native file types in the bundler. The `bunfig.toml`
in this repo has the stanza commented out to avoid the misleading error.

### `inspector-plugin-default.ts`

A thin default-export re-export for use with `Bun.build({ plugins: [...] })` or
`bunfig.toml` when you want to intercept *non-native* file types in a build step.

### Future: when Bun exposes onBeforeParse from JavaScript

If Bun ever makes `onBeforeParse` accessible from JS plugins (not just NAPI), the
`inspector-plugin.ts` approach would work without any pre-transform step. The plugin
could be registered as:

```ts
Bun.plugin({
  name: "dev-inspector",
  setup(build) {
    build.onBeforeParse({ filter: /\.(tsx|jsx)$/ }, async (args) => {
      // hypothetical JS-accessible hook
      return { contents: await transformCode({ content: args.contents, ... }) };
    });
  },
});
```

---

## What would "first-class" Bun support in the library look like?

If this pattern were upstreamed to `@mcpc-tech/unplugin-dev-inspector-mcp`, it would
add:

1. A `bunDevInspector(options)` export — mirrors the existing `turbopackDevInspector()`
   at `src/turbopack.ts:134`. It calls `startStandaloneServer()` and returns the
   pre-transform script path for users to reference.

2. `"bun"` added to `BundlerType` in `src/commands/setup/types.ts` and a new
   `src/commands/setup/frameworks/bun.ts` with `detectBunConfig` / `transformBunConfig`
   — so `npx dev-inspector setup` auto-wires a Bun project.

3. The pre-transform logic moved into the package itself so users don't copy scripts.

For now, this POC is the complete working recipe.

---

## Troubleshooting

**Inspector bar doesn't appear**
- Check that port 6137 is free before starting: `lsof -i :6137`
- Verify the inspector server started: `curl http://localhost:6137/ping` → `pong`
- Check browser console for errors loading `/__inspector__/inspector.js`

**Click-to-source shows component name, not file:line**
- The `_transformed/` directory may be stale. Delete it and re-run `bun dev`.
- Verify: `grep -r "data-insp-path" _transformed/src/` — should show absolute paths.

**MCP connection refused in Claude Code / Cursor**
- The server URL is `http://localhost:6137/__mcp__/sse` (SSE transport).
- Some editors require restarting after `.cursor/mcp.json` is written.
- Try: `curl -s http://localhost:6137/__mcp__/sse` — should keep the connection open.

**Port 6137 already in use**
- The server auto-increments: check the console banner for the actual port.
- Set a custom port: `DEV_INSPECTOR_PORT=6200 bun dev`
