import ts from "typescript";

/**
 * TypeScript / TSX syntax checker using the TS compiler API.
 *
 * Uses getSyntacticDiagnostics() — syntax errors only (TS1xxx codes).
 * Type errors and import resolution are deliberately skipped via noResolve,
 * because LLM-generated files are checked in isolation and imports can't
 * be resolved cross-file at this stage.
 *
 * Runs synchronously, entirely in-memory (no disk I/O, no subprocess).
 * Returns an empty array for non-TS files and on any unexpected failure.
 */
export function checkTypeScriptSyntax(
  filePath: string,
  content: string,
): string[] {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (!["ts", "tsx", "jsx", "js"].includes(ext)) return [];

  try {
    const isJsx = ext === "tsx" || ext === "jsx";
    // Use a stable virtual name — the real path isn't on the TS include list
    const virtualName = `__check__.${ext}`;

    const sourceFile = ts.createSourceFile(
      virtualName,
      content,
      ts.ScriptTarget.ES2017,
      true,
      isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    // Virtual compiler host — only serves the single file we're checking
    const host = ts.createCompilerHost({});
    const origGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion) => {
      if (name === virtualName) return sourceFile;
      return origGetSourceFile(name, languageVersion);
    };
    host.fileExists = (name) => name === virtualName;
    host.readFile = (name) => (name === virtualName ? content : undefined);

    const program = ts.createProgram(
      [virtualName],
      {
        noEmit: true,
        strict: false,
        skipLibCheck: true,
        // Prevent import resolution — we only want syntax errors
        noResolve: true,
        jsx: isJsx ? ts.JsxEmit.ReactJSX : undefined,
        target: ts.ScriptTarget.ES2017,
        allowJs: true,
      },
      host,
    );

    const diagnostics = program.getSyntacticDiagnostics(sourceFile);
    const syntaxErrors = diagnostics
      .slice(0, 3) // cap: keep feedback short for small models
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));

    if (syntaxErrors.length > 0) return syntaxErrors;

    // Also run a filtered set of semantic diagnostics. We skip most type
    // errors (they fire on isolated files because imports are unresolved) but
    // keep codes that are definitively wrong regardless of context:
    //   TS2448 — block-scoped variable used before declaration (let x = x;)
    //   TS2454 — variable used before being assigned
    //   TS2300 — duplicate identifier
    //   TS2695 — LHS is always a constant (often `let x = x` shadow)
    const SAFE_SEMANTIC_CODES = new Set([2448, 2454, 2300, 2695, 2393]);
    const semanticDiags = program
      .getSemanticDiagnostics(sourceFile)
      .filter((d) => SAFE_SEMANTIC_CODES.has(d.code));
    return semanticDiags
      .slice(0, 3)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
  } catch {
    // Never block the pipeline on an unexpected TS API failure
    return [];
  }
}

/**
 * Extract exported symbol signatures from a TS/TSX source string.
 *
 * Returns one short line per export — enough to tell another LLM call what
 * exists already without dumping the full file. Examples:
 *
 *   export default function App(): JSX.Element
 *   export function handleAdd(item: string): void
 *   export const Card: React.FC<CardProps>
 *   export interface CardProps { title: string; onDelete: () => void }
 *
 * Used to inject cross-file context when the developer writes the next file,
 * so it knows what props/types/functions already exist and doesn't redefine
 * them. Safe on malformed input — returns [] rather than throwing.
 */
export function extractExportSignatures(
  filePath: string,
  content: string,
): string[] {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (!["ts", "tsx", "jsx", "js"].includes(ext)) return [];

  try {
    const isJsx = ext === "tsx" || ext === "jsx";
    const sourceFile = ts.createSourceFile(
      `__sig__.${ext}`,
      content,
      ts.ScriptTarget.ES2017,
      true,
      isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const sigs: string[] = [];

    const sliceText = (node: ts.Node, max = 200): string => {
      const start = node.getStart(sourceFile);
      const end = node.getEnd();
      let txt = content.slice(start, end).replace(/\s+/g, " ").trim();
      if (txt.length > max) txt = txt.slice(0, max - 3) + "...";
      return txt;
    };

    const visit = (node: ts.Node) => {
      // Only top-level declarations
      if (node.parent && node.parent.kind !== ts.SyntaxKind.SourceFile) return;

      // export default function|class|...
      if (
        ts.isFunctionDeclaration(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const isDefault = node.modifiers.some(
          (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
        );
        const name = node.name?.text || "default";
        const params = node.parameters.map((p) => sliceText(p, 60)).join(", ");
        const ret = node.type ? `: ${sliceText(node.type, 40)}` : "";
        sigs.push(
          `export ${isDefault ? "default " : ""}function ${name}(${params})${ret}`,
        );
        return;
      }

      // export const X = ... | export const X: T = ...
      if (
        ts.isVariableStatement(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const name = decl.name.text;
          if (decl.type) {
            sigs.push(`export const ${name}: ${sliceText(decl.type, 80)}`);
            continue;
          }
          // No explicit type — peek at the initializer. Arrow functions /
          // function expressions tell us the parameter shape, which is the
          // most useful thing to leak to the next file's developer.
          const init = decl.initializer;
          if (
            init &&
            (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
          ) {
            const params = init.parameters
              .map((p) => sliceText(p, 60))
              .join(", ");
            const ret = init.type ? `: ${sliceText(init.type, 40)}` : "";
            sigs.push(`export const ${name} = (${params})${ret} => ...`);
          } else {
            sigs.push(`export const ${name}`);
          }
        }
        return;
      }

      // export interface Foo { ... } — keep the body but truncate
      if (
        ts.isInterfaceDeclaration(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        sigs.push(sliceText(node, 200));
        return;
      }

      // export type Foo = ...
      if (
        ts.isTypeAliasDeclaration(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        sigs.push(sliceText(node, 200));
        return;
      }

      // export class Foo
      if (
        ts.isClassDeclaration(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const isDefault = node.modifiers.some(
          (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
        );
        const name = node.name?.text || "default";
        sigs.push(`export ${isDefault ? "default " : ""}class ${name}`);
        return;
      }

      // export default <Identifier> — anonymous default exports
      if (ts.isExportAssignment(node) && !node.isExportEquals) {
        const expr = sliceText(node.expression, 80);
        sigs.push(`export default ${expr}`);
        return;
      }
    };

    sourceFile.forEachChild(visit);
    return sigs;
  } catch {
    return [];
  }
}

/**
 * Run semantic diagnostics on a TS/TSX source. Filters out errors that are
 * artefacts of in-isolation checking (unresolved imports, missing JSX runtime,
 * missing React namespace) since the file is checked without its dependencies
 * on disk. What's left is genuine type/scope mistakes the model made: wrong
 * prop types, undefined identifiers within the file, type mismatches, etc.
 *
 * Returns short human-readable strings, capped at 5.
 */
export function checkTypeScriptSemantics(
  filePath: string,
  content: string,
): string[] {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (!["ts", "tsx", "jsx", "js"].includes(ext)) return [];

  try {
    const isJsx = ext === "tsx" || ext === "jsx";
    const virtualName = `__sem__.${ext}`;

    const sourceFile = ts.createSourceFile(
      virtualName,
      content,
      ts.ScriptTarget.ES2017,
      true,
      isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const host = ts.createCompilerHost({});
    const origGetSourceFile = host.getSourceFile.bind(host);
    const origFileExists = host.fileExists.bind(host);
    const origReadFile = host.readFile.bind(host);
    host.getSourceFile = (name, languageVersion) => {
      if (name === virtualName) return sourceFile;
      return origGetSourceFile(name, languageVersion);
    };
    // Allow lib.*.d.ts through so standard-library types resolve; block
    // everything else so cross-file imports stay unresolved (intentional —
    // we want only single-file semantic errors).
    host.fileExists = (name) =>
      name === virtualName || /\blib\.[\w.]+\.d\.ts$/.test(name)
        ? origFileExists(name)
        : false;
    host.readFile = (name) =>
      name === virtualName
        ? content
        : /\blib\.[\w.]+\.d\.ts$/.test(name)
          ? origReadFile(name)
          : undefined;

    const program = ts.createProgram(
      [virtualName],
      {
        noEmit: true,
        strict: false,
        skipLibCheck: true,
        noResolve: true,
        jsx: isJsx ? ts.JsxEmit.ReactJSX : undefined,
        target: ts.ScriptTarget.ES2017,
        // Default lib includes ES + DOM globals (Array, string.trim, document,
        // setTimeout, etc.) so we don't false-positive on standard library use.
        // Without this, every call to .trim() / .map() / document.* trips
        // "Property does not exist on type" errors.
        lib: ["lib.es2017.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
        allowJs: true,
      },
      host,
    );

    const diags = program.getSemanticDiagnostics(sourceFile);

    // Codes to ignore — they're noise when checking in isolation (no deps on disk):
    //   2304 — Cannot find name 'X' (matches React, JSX, useState, etc.)
    //   2305 — Module '...' has no exported member 'X' (we don't resolve modules)
    //   2306 — File '...' is not a module
    //   2307 — Cannot find module
    //   2503 — Cannot find namespace 'JSX' / 'React'
    //   2552 — Cannot find name 'X'. Did you mean 'Y'?
    //   2580 — Cannot find name 'require' / 'process'
    //   2686 — 'X' refers to a UMD global
    //   2691 — Import path cannot end with extension
    //   2792 — Cannot find module — Did you mean to set 'moduleResolution'
    //   7016 — Could not find a declaration file for module
    //   17004 — Cannot use JSX unless the '--jsx' flag is provided
    //   18048 — value is possibly 'undefined' (often noise without strict)
    const IGNORE = new Set([
      2304, 2305, 2306, 2307, 2503, 2552, 2580, 2686, 2691, 2792, 7016, 17004,
      18048,
    ]);

    const messages: string[] = [];
    for (const d of diags) {
      if (IGNORE.has(d.code)) continue;
      const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
      // Skip messages that mention "module" or "namespace" cross-file noise
      if (/cannot find module|cannot find namespace/i.test(msg)) continue;
      messages.push(msg);
      if (messages.length >= 5) break;
    }

    return messages;
  } catch {
    return [];
  }
}
