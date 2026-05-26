/**
 * Auto-stub generator for undefined identifiers in LLM-generated TSX.
 *
 * When the model has used 5 recovery rounds and still references symbols
 * it never declared (e.g. `<button onClick={handleStartPause}>` with no
 * `handleStartPause`), we'd rather ship a renderable component with stub
 * handlers than a `ReferenceError` page. Stubs preserve the UI shape so
 * the user can iterate via the feedback pass.
 *
 * Strategy: for each undefined name, infer a sensible stub:
 *   - If it looks like a handler (`handleFoo`, `onFoo`, `doFoo`): `const X = () => {};`
 *   - If it looks like a setter (`setFoo`): pair with `const [foo, setFoo] = useState(...)`
 *   - Otherwise: `const X = undefined as any;`
 *
 * Returns the modified source with stubs inserted just inside the main
 * component function body (best-effort) or right after the imports as
 * a fallback. Also returns the list of stubs added so callers can log
 * them as a known-broken-but-renderable status.
 */

import ts from "typescript";
import { findUndefinedIdentifiers } from "./undef-check";

export interface AutoStubResult {
  /** The patched source (unchanged if nothing was stubbed) */
  content: string;
  /** Names of identifiers that were stubbed */
  stubbedNames: string[];
}

const HANDLER_RE = /^(handle|on|do)[A-Z]\w*$/;
const SETTER_RE = /^set[A-Z]\w*$/;

export function autoStubUndefs(
  filePath: string,
  content: string,
): AutoStubResult {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (!["ts", "tsx", "jsx", "js"].includes(ext)) {
    return { content, stubbedNames: [] };
  }

  const issues = findUndefinedIdentifiers(filePath, content);
  if (issues.length === 0) return { content, stubbedNames: [] };

  // Dedupe by name
  const names = Array.from(new Set(issues.map((i) => i.name)));

  // Build stub lines
  const stateStubs: string[] = [];
  const handlerStubs: string[] = [];
  const otherStubs: string[] = [];
  const stubbed: string[] = [];

  for (const name of names) {
    if (HANDLER_RE.test(name)) {
      handlerStubs.push(`  const ${name} = () => {};`);
      stubbed.push(name);
    } else if (SETTER_RE.test(name)) {
      const stateName = name.slice(3, 4).toLowerCase() + name.slice(4);
      // Only stub if the paired state name is ALSO undefined (otherwise
      // setFoo was actually destructured fine and we mis-read).
      if (names.includes(stateName)) {
        // Will be handled when we encounter the state name below;
        // skip emitting a duplicate.
        continue;
      }
      stateStubs.push(
        `  const [${stateName}, ${name}] = React.useState<any>(undefined);`,
      );
      stubbed.push(name);
    } else if (
      names.some((n) => n === `set${name[0]?.toUpperCase()}${name.slice(1)}`)
    ) {
      // This is the value half of a missing useState pair
      const setterName = `set${name[0].toUpperCase()}${name.slice(1)}`;
      stateStubs.push(
        `  const [${name}, ${setterName}] = React.useState<any>(undefined);`,
      );
      stubbed.push(name, setterName);
    } else {
      otherStubs.push(`  const ${name}: any = undefined;`);
      stubbed.push(name);
    }
  }

  if (stubbed.length === 0) return { content, stubbedNames: [] };

  const stubBlock = [
    "  // ── auto-generated stubs (model omitted these declarations) ──",
    ...stateStubs,
    ...handlerStubs,
    ...otherStubs,
    "  // ── end stubs ──",
  ].join("\n");

  // Find the main component function body opening brace.
  try {
    const isJsx = ext === "tsx" || ext === "jsx";
    const sourceFile = ts.createSourceFile(
      `__stub__.${ext}`,
      content,
      ts.ScriptTarget.ES2017,
      true,
      isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    // Find first function-like top-level node that returns JSX
    let insertPos: number | null = null;
    for (const stmt of sourceFile.statements) {
      let fn: ts.FunctionDeclaration | ts.ArrowFunction | undefined;
      if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        fn = stmt;
      } else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (
            d.initializer &&
            ts.isArrowFunction(d.initializer) &&
            d.initializer.body
          ) {
            fn = d.initializer;
            break;
          }
        }
      } else if (
        (ts.isExportAssignment(stmt) || ts.isExportDeclaration(stmt)) &&
        // not the kind we need
        false
      ) {
        // skip
      }
      if (fn && fn.body && ts.isBlock(fn.body)) {
        insertPos = fn.body.getStart(sourceFile) + 1; // just after the {
        break;
      }
    }

    if (insertPos !== null) {
      const before = content.slice(0, insertPos);
      const after = content.slice(insertPos);
      return {
        content: `${before}\n${stubBlock}\n${after}`,
        stubbedNames: stubbed,
      };
    }
  } catch {
    // fall through to import-suffix strategy
  }

  // Fallback: insert at top of file after any imports.
  const lines = content.split("\n");
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\b/.test(lines[i])) lastImportIdx = i;
    else if (lastImportIdx >= 0 && lines[i].trim() === "") continue;
    else if (lastImportIdx >= 0) break;
  }
  const insertAt = lastImportIdx >= 0 ? lastImportIdx + 1 : 0;
  const top = [
    "",
    "// ── auto-generated stubs (model omitted these declarations) ──",
    ...stateStubs.map((s) => s.trimStart()),
    ...handlerStubs.map((s) => s.trimStart()),
    ...otherStubs.map((s) => s.trimStart()),
    "// ── end stubs ──",
  ];
  lines.splice(insertAt, 0, ...top);
  return { content: lines.join("\n"), stubbedNames: stubbed };
}
