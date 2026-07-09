import { useState } from "react";

function Counter({ label }: { label: string }) {
  const [count, setCount] = useState(0);
  return (
    <div style={{ padding: "1rem", border: "1px solid #ccc", borderRadius: 8 }}>
      <p>
        {label}: {count}
      </p>
      <button onClick={() => setCount((c) => c + 1)}>Increment</button>
    </div>
  );
}

export function App() {
  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "4rem auto" }}>
      <h1>Bun + dev-inspector-mcp POC</h1>
      <p>
        Click the inspector bar (bottom-right) then click any element to see accurate
        <code>file:line:col</code> source attribution from the pre-transform step.
      </p>
      <Counter label="Alpha" />
      <Counter label="Beta" />
    </main>
  );
}
