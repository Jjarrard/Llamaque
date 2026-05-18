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
    return diagnostics
      .slice(0, 3) // cap: keep feedback short for small models
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
  } catch {
    // Never block the pipeline on an unexpected TS API failure
    return [];
  }
}
