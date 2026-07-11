import { useState } from "react";

const buttonStyle: React.CSSProperties = {
  padding: "8px 24px",
  border: "none",
  borderRadius: 4,
  backgroundColor: "#1976d2",
  color: "#fff",
  fontSize: 14,
  fontWeight: 500,
  letterSpacing: 0.5,
  textTransform: "uppercase" as const,
  cursor: "pointer",
  boxShadow: "0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24)",
  transition: "box-shadow 0.2s, background-color 0.2s",
};

const buttonHoverStyle: React.CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#1565c0",
  boxShadow: "0 3px 6px rgba(0,0,0,0.16), 0 3px 6px rgba(0,0,0,0.23)",
};

function Counter({ label }: { label: string }) {
  const [count, setCount] = useState(0);
  const [hovered, setHovered] = useState(false);
  return (
    <div style={{ padding: "1rem", border: "1px solid #e0e0e0", borderRadius: 8, backgroundColor: "#fafafa", marginBottom: "0.75rem" }}>
      <p style={{ margin: "0 0 0.75rem", fontSize: 16 }}>
        {label}: <strong>{count}</strong>
      </p>
      <input type="button"
        value="Increment"
        style={hovered ? buttonHoverStyle : buttonStyle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => setCount((c) => c + 1)}
        />
    </div>
  );
}

function StatusBar() {
  return (
    <footer style={{
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      display: "flex",
      alignItems: "center",
      gap: "1.5rem",
      padding: "8px 16px",
      backgroundColor: "#263238",
      color: "#cfd8dc",
      fontSize: 12,
      fontFamily: "monospace",
    }}>
      <StatusIndicator label="Server" status="connected" />
      <StatusIndicator label="MCP" status="connected" />
      <StatusIndicator label="Agent" status="ready" />
    </footer>
  );
}

function StatusIndicator({ label, status }: { label: string; status: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        backgroundColor: status === "connected" || status === "ready" ? "#66bb6a" : "#ef5350",
        display: "inline-block",
      }} />
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span>{status}</span>
    </span>
  );
}

export function App() {
  return (
    <>
      <StatusBar />
      <main style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "4rem auto", paddingTop: 60 }}>
        <h1>Bun + dev-inspector-mcp POC</h1>
        <p>
          Click the inspector bar (bottom-right) then click any element to see accurate
          <code>file:line:col</code> source attribution injected inline by the NAPI bridge.
        </p>
        <Counter label="Alpha" />
        <Counter label="Beta" />
      </main>
    </>
  );
}
