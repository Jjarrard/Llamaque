import { describe, it, expect } from "vitest";
import { detectComponentName } from "@/lib/ops/component-detect";

describe("detectComponentName", () => {
  it("finds export default function Name", () => {
    expect(
      detectComponentName(
        `export default function MyApp() { return <div/>; }`,
        "MyApp.tsx",
      ),
    ).toBe("MyApp");
  });

  it("finds `const Foo: React.FC<...> = ...; export default Foo;`", () => {
    const src = `
import React from "react";
const GameOfLife: React.FC<Props> = ({rows}) => { return <div/>; };
export default GameOfLife;
`;
    expect(detectComponentName(src, "GameOfLife.tsx")).toBe("GameOfLife");
  });

  it("finds `const Foo = (props) => ...` arrow", () => {
    const src = `
import React from "react";
const Pomodoro = () => { return <div/>; };
export default Pomodoro;
`;
    expect(detectComponentName(src, "Pomodoro.tsx")).toBe("Pomodoro");
  });

  it("finds `export default Foo;` where Foo is defined separately", () => {
    const src = `
const Foo = () => <div/>;
const App = Foo;
export default App;
`;
    expect(detectComponentName(src, "App.tsx")).toBe("App");
  });

  it("finds class component", () => {
    const src = `class Counter extends React.Component { render() { return <div/>; } }`;
    expect(detectComponentName(src, "Counter.tsx")).toBe("Counter");
  });

  it("falls back to filename when nothing matches but file is PascalCase", () => {
    const src = `// nothing here`;
    expect(detectComponentName(src, "MyThing.tsx")).toBe("MyThing");
  });

  it("falls back to 'Component' when filename is lowercase", () => {
    const src = `// nothing here`;
    expect(detectComponentName(src, "page.tsx")).toBe("Component");
    expect(detectComponentName("", "")).toBe("Component");
  });

  it("handles memo and forwardRef", () => {
    expect(
      detectComponentName(
        `const Item = memo((props) => <div/>); export default Item;`,
        "Item.tsx",
      ),
    ).toBe("Item");
    expect(
      detectComponentName(
        `const Input = forwardRef((p, r) => <input ref={r}/>); export default Input;`,
        "Input.tsx",
      ),
    ).toBe("Input");
  });

  it("ignores `export default function` when no name (anonymous)", () => {
    const src = `export default function() { return <div/>; }`;
    // No name → falls through to filename
    expect(detectComponentName(src, "MyComp.tsx")).toBe("MyComp");
  });
});
