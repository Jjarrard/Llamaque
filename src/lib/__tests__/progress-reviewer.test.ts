import { describe, it, expect } from "vitest";
import { parseProgress } from "@/lib/agents/progress-reviewer";

describe("parseProgress", () => {
  const files = ["App.tsx", "TodoList.tsx", "TodoItem.tsx"];

  it("parses a well-formed PROGRESS block", () => {
    const text = `>>PROGRESS
done:
- shows todo list
- can add a todo
missing:
- delete button in TodoItem.tsx
- mark complete in App.tsx
nextAction: Add a delete button to each todo item.
>>END`;
    const result = parseProgress(text, files);
    expect(result.done).toEqual(["shows todo list", "can add a todo"]);
    expect(result.missing).toEqual([
      { feature: "delete button", file: "TodoItem.tsx" },
      { feature: "mark complete", file: "App.tsx" },
    ]);
    expect(result.nextAction).toBe("Add a delete button to each todo item.");
  });

  it("handles empty missing list", () => {
    const text = `>>PROGRESS
done:
- everything
missing:
nextAction: All spec features implemented.
>>END`;
    const result = parseProgress(text, files);
    expect(result.missing).toEqual([]);
    expect(result.done).toEqual(["everything"]);
  });

  it("falls back to first file when no file specified", () => {
    const text = `>>PROGRESS
done:
missing:
- a thing
nextAction: do the thing
>>END`;
    const result = parseProgress(text, files);
    expect(result.missing).toEqual([{ feature: "a thing", file: "App.tsx" }]);
  });

  it("detects file mentioned in bullet text", () => {
    const text = `>>PROGRESS
missing:
- TodoList.tsx is missing pagination
>>END`;
    const result = parseProgress(text, files);
    expect(result.missing[0].file).toBe("TodoList.tsx");
  });

  it("tolerates missing >>END marker", () => {
    const text = `>>PROGRESS
done:
- a
missing:
- b in App.tsx`;
    const result = parseProgress(text, files);
    expect(result.done).toEqual(["a"]);
    expect(result.missing).toEqual([{ feature: "b", file: "App.tsx" }]);
  });
});
