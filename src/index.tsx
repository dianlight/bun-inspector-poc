// DevInspector from the `/next` export is a plain `useEffect`-based React component
// that works in any React 19 app regardless of bundler.
//
// It:
//  1. Sets window.__DEV_INSPECTOR_CONFIG__ (read by the inspector client at runtime)
//  2. Dynamically appends <dev-inspector-mcp> custom element to document.body
//  3. Injects <script src="http://localhost:6137/__inspector__/inspector.js">
//
// It is guarded by window.__DEV_INSPECTOR_LOADED__ so hot reloads never double-mount.
// Source: packages/unplugin-dev-inspector/src/next.tsx
import { DevInspector } from "@mcpc-tech/unplugin-dev-inspector-mcp/next";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.getElementById("root");
if (container){
const root = createRoot(container);

root.render(
  <>
    <App />
    {/* DevInspector connects to the standalone server started by: npx dev-inspector-server */}
    <DevInspector
      host="localhost"
      port={6137}
      disableChrome={true}
    />
  </>,
);
}
