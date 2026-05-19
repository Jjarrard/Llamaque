/**
 * Tests for validateOutput — focusing on the JSX-in-script HTML guard
 * and other structural validations.
 */
import { describe, it, expect } from "vitest";
import { validateOutput, autoRepairOutput } from "@/lib/validate";

describe("validateOutput — HTML JSX-in-script guard", () => {
  const plainHtml = `<!DOCTYPE html>
<html><head><title>App</title></head>
<body><div id="root"></div></body>
</html>`;

  it("passes clean plain HTML", () => {
    expect(validateOutput(plainHtml, "index.html").valid).toBe(true);
  });

  it("rejects HTML with React import inside <script>", () => {
    const html = `<!DOCTYPE html>
<html><head></head><body>
<script>
  import React, { useState } from "react";
  export default function Counter() { return <div>0</div>; }
</script>
</body></html>`;
    const result = validateOutput(html, "index.html");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/React\/JSX/);
  });

  it("rejects HTML with export default function inside <script>", () => {
    const html = `<!DOCTYPE html><html><body>
<script>
export default function Component() {
  return <div>hello</div>;
}
</script>
</body></html>`;
    const result = validateOutput(html, "index.html");
    expect(result.valid).toBe(false);
  });

  it("rejects HTML with JSX return inside <script>", () => {
    const html = `<!DOCTYPE html><html><body>
<script>
function App() {
  return (
    <div className="app">hello</div>
  );
}
</script></body></html>`;
    const result = validateOutput(html, "index.html");
    expect(result.valid).toBe(false);
  });

  it("rejects HTML with duplicate export default function in <script>", () => {
    const html = `<!DOCTYPE html><html><body>
<script>
export default function Component() { return <div/>; }
export default function Component() { return <div/>; }
</script></body></html>`;
    const result = validateOutput(html, "index.html");
    expect(result.valid).toBe(false);
  });

  it("passes HTML with normal vanilla JS in <script>", () => {
    const html = `<!DOCTYPE html>
<html><head></head><body>
<div id="count">0</div>
<button onclick="inc()">+</button>
<script>
  var count = 0;
  function inc() {
    count++;
    document.getElementById("count").textContent = count;
  }
</script>
</body></html>`;
    expect(validateOutput(html, "index.html").valid).toBe(true);
  });
});

describe("validateOutput — TSX guards", () => {
  it("rejects TSX that starts with HTML doctype", () => {
    const result = validateOutput("<!DOCTYPE html><html></html>", "App.tsx");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/HTML document/);
  });

  it("rejects TSX with no default export", () => {
    const result = validateOutput(
      `import React from "react";\nfunction Counter() { return <div>0</div>; }`,
      "App.tsx",
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/default export/);
  });

  it("passes valid TSX component", () => {
    const code = `import React, { useState } from "react";
export default function Counter() {
  const [n, setN] = useState(0);
  return <div><button onClick={() => setN(n+1)}>+</button><span>{n}</span></div>;
}`;
    expect(validateOutput(code, "Counter.tsx").valid).toBe(true);
  });
});

describe("autoRepairOutput — CSS extra closing braces", () => {
  it("strips a single trailing extra `}` from CSS", () => {
    const css = `body { margin: 0; }\n.btn { color: red; }\n}`;
    const { repaired, fixes } = autoRepairOutput(css, "style.css");
    expect(fixes.some((f) => f.includes("extra closing brace"))).toBe(true);
    expect(validateOutput(repaired, "style.css").valid).toBe(true);
  });

  it("strips two trailing extra `}` from CSS", () => {
    const css = `body { margin: 0; }\n.btn { color: red; }\n}\n}`;
    const { repaired, fixes } = autoRepairOutput(css, "style.css");
    expect(fixes.some((f) => f.includes("extra closing brace"))).toBe(true);
    expect(validateOutput(repaired, "style.css").valid).toBe(true);
  });

  it("does not modify CSS that already has balanced braces", () => {
    const css = `body { margin: 0; }\n.btn { color: red; }`;
    const { repaired, fixes } = autoRepairOutput(css, "style.css");
    expect(fixes).toHaveLength(0);
    expect(repaired.trim()).toBe(css.trim());
  });

  it("strips trailing `}` but validates pass on CSS from RECOVER pattern", () => {
    // Simulate the exact pattern the model produces: valid CSS + trailing `}`
    const css = [
      "* { box-sizing: border-box; }",
      "body { font-family: sans-serif; }",
      ".counter { display: flex; flex-direction: column; }",
      "}",
    ].join("\n");
    const { repaired } = autoRepairOutput(css, "styles.css");
    expect(validateOutput(repaired, "styles.css").valid).toBe(true);
  });
});

describe("validateOutput — TSX setter scoping", () => {
  const goodComponent = `
import React, { useState } from "react";
export default function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button onClick={() => setCount(count + 1)}>+</button>
      <span>{count}</span>
    </div>
  );
}`.trim();

  const badComponent = `
import React from "react";
export default function Component() {
  return (
    <div>
      <button onClick={() => setCount(count + 1)}>+</button>
    </div>
  );
}`.trim();

  it("accepts a component with matching useState for every setter", () => {
    expect(validateOutput(goodComponent, "Counter.tsx").valid).toBe(true);
  });

  it("rejects a component that calls setCount without a matching useState", () => {
    const result = validateOutput(badComponent, "index.tsx");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/setCount/);
  });

  it("accepts dataTransfer.setData() (HTML5 drag-and-drop, not a React setter)", () => {
    const dragCode = `
import React, { useState } from "react";
export default function Board() {
  const [items, setItems] = useState<string[]>([]);
  const onDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData("cardId", id);
    e.dataTransfer.setData("sourceColumn", "todo");
  };
  return <div draggable onDragStart={(e) => onDragStart(e, "1")}>{items.length}</div>;
}`.trim();
    expect(validateOutput(dragCode, "Board.tsx").valid).toBe(true);
  });

  it("accepts localStorage.setItem and element.setAttribute (DOM APIs)", () => {
    const domCode = `
import React, { useEffect } from "react";
export default function Persist() {
  useEffect(() => {
    localStorage.setItem("key", "value");
    document.body.setAttribute("data-ready", "true");
  }, []);
  return <div />;
}`.trim();
    expect(validateOutput(domCode, "Persist.tsx").valid).toBe(true);
  });
});
