/**
 * Detect the React component name to render from a TSX/JSX source string.
 *
 * The preview HTML (both the route and the visual-QA gate) does a
 * `typeof <Name> !== "undefined"` check to decide what to mount. If the
 * detection misses the actual export, the page shows "No component
 * found" even when the file is perfectly valid.
 *
 * Tries multiple patterns in priority order so we cover the common
 * idioms small models emit:
 *   1. `export default function Foo(...)`
 *   2. `export default Foo;` (where Foo is a const/class above)
 *   3. `const Foo: React.FC<...> = ...` (FC pattern)
 *   4. `const Foo = (...) => ...` (arrow function const)
 *   5. `function Foo(...)` (plain function declaration)
 *   6. `class Foo extends React.Component`
 *   7. Filename basename (when PascalCase)
 *   8. Literal string "Component" (last-ditch fallback)
 */
export function detectComponentName(source: string, filename: string): string {
  // 1. export default function Foo
  const m1 = source.match(/export\s+default\s+function\s+(\w+)/);
  if (m1) return m1[1];

  // 2. export default Foo;  (pick last; ignore keywords)
  const m2Re = /export\s+default\s+(\w+)\s*;?/g;
  let last: RegExpExecArray | null;
  let lastMatch: string | null = null;
  while ((last = m2Re.exec(source)) !== null) {
    if (!/^(function|class|async|const|let|var)$/.test(last[1])) {
      lastMatch = last[1];
    }
  }
  if (lastMatch) return lastMatch;

  // 3 + 4. const Foo: ... = (React.FC / arrow / function / memo / forwardRef)
  const m3 = source.match(
    /(?:^|\n)\s*(?:export\s+)?const\s+([A-Z]\w*)\s*(?::[^=]+)?=\s*(?:React\.\w+<|\([^)]*\)\s*=>|function\b|memo\(|forwardRef\()/,
  );
  if (m3) return m3[1];

  // 5. function Foo (PascalCase)
  const m4 = source.match(/(?:^|\n)\s*function\s+([A-Z]\w*)/);
  if (m4) return m4[1];

  // 6. class Foo extends React.*
  const m5 = source.match(/(?:^|\n)\s*class\s+([A-Z]\w*)\s+extends\s+React\./);
  if (m5) return m5[1];

  // 7. filename basename, if PascalCase
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.\w+$/, "");
  if (/^[A-Z]/.test(base)) return base;

  // 8. last-ditch
  return "Component";
}
