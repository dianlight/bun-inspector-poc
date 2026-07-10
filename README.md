# bun-inspector-poc

React 19 + Bun fullstack dev server with [`dev-inspector-mcp`](https://github.com/mcpc-tech/dev-inspector-mcp) integration.

**Features:**
- Native HMR (via Bun's dev server)
- Browser console → terminal forwarding
- Click-to-source inspector with `file:line:col` accuracy
- MCP endpoint for AI agent integration

---

## Quick start

```sh
bun install
bun dev
```

Open <http://localhost:3000>. Use the floating inspector bar (bottom-right) to click
any element and see its source location.

---

## How it works

```
bun dev
├── Bun.spawn → dev-inspector-mcp server (port 6137)
│   └── serves inspector UI, MCP SSE, AI agent chat
│
└── Bun.serve({ routes: { "/": index.html }, development: { hmr: true } })
    └── inspector-plugin.ts registered via bunfig.toml [serve.static]
        └── transforms .tsx/.jsx → injects data-insp-path attributes
```

Bun's dev server handles HMR natively. Save a file → browser updates without reload.

### The inspector transform

`inspector-plugin.ts` uses `@code-inspector/core` to inject `data-insp-path` attributes:

```tsx
// Before
<button onClick={...}>Increment</button>

// After (inline, no files written)
<button onClick={...} data-insp-path="/abs/path/src/App.tsx:10:7:button">
  Increment
</button>
```

The inspector reads these at runtime. Click an element → reports `file:line:col` to the
MCP server → AI agent opens the exact line in your editor.

---

## Project structure

```
bun-inspector-poc/
├── dev.ts                      ← spawns MCP server + starts Bun.serve()
├── index.html                  ← HTML entry point (HTML import)
├── bunfig.toml                 ← registers inspector-plugin-default.ts
├── inspector-plugin.ts         ← Bun onLoad plugin (data-insp-path transform)
├── inspector-plugin-default.ts ← default-export wrapper for bunfig.toml
├── src/
│   ├── index.tsx               ← app entry; mounts <DevInspector/>
│   └── App.tsx                 ← demo React components
└── package.json
```

---

## Connecting an AI agent

The MCP server starts automatically at `http://localhost:6137/__mcp__/sse`.

### Claude Code

```sh
claude mcp add dev-inspector http://localhost:6137/__mcp__/sse
```

### Cursor / VS Code

The server auto-writes `.cursor/mcp.json` and `.vscode/mcp.json`. Restart to pick up,
or add manually:

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
| `capture_element_context` | Click element → source file, component tree, styles, screenshot |
| `capture_area_context` | Rubber-band select → all elements in region |
| `execute_page_script` | Run arbitrary JS in browser context |
| `get_console_logs` | Browser console output |
| `chrome_*` tools | Full Chrome DevTools Protocol |

---

## Troubleshooting

**Inspector bar doesn't appear**
- Check port 6137: `lsof -i :6137`
- Verify server: `curl http://localhost:6137/ping` → `pong`

**MCP connection refused**
- URL is `http://localhost:6137/__mcp__/sse`
- Some editors need restart after `.cursor/mcp.json` is written

**Port 6137 already in use**
- Server auto-increments; check console banner
- Custom port: `DEV_INSPECTOR_PORT=6200 bun dev`
