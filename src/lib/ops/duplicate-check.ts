import ts from "typescript";

/**
 * AST-based duplicate symbol detector.
 *
 * Walks a TS/TSX/JS/JSX source and collects all top-level declared symbols
 * (function declarations, const/let/var bindings, class declarations,
 * type aliases, interfaces, enum declarations). Returns one issue per
 * duplicate name with both line numbers so the prompt can surface a
 * precise fix instruction to the model.
 *
 * Catches the most common LLM failure mode where iterative QA rewrites
 * cause a function to be defined twice (e.g. Pomodoro's `seconds`, Game
 * of Life's `countNeighbors`).
 *
 * Non-TS files: returns []. Parse failures: returns [] (never blocks
 * the pipeline on an unexpected AST crash).
 */
export interface DuplicateIssue {
  name: string;
  firstLine: number;
  secondLine: number;
  kind: string;
}

export function findDuplicateSymbols(
  filePath: string,
  content: string,
): DuplicateIssue[] {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (!["ts", "tsx", "jsx", "js"].includes(ext)) return [];

  try {
    const isJsx = ext === "tsx" || ext === "jsx";
    const sourceFile = ts.createSourceFile(
      `__dup__.${ext}`,
      content,
      ts.ScriptTarget.ES2017,
      true,
      isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    type Decl = { line: number; kind: string };
    const seen = new Map<string, Decl>();
    const issues: DuplicateIssue[] = [];

    const lineOf = (node: ts.Node): number =>
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
      1;

    const record = (name: string, kind: string, line: number) => {
      const existing = seen.get(name);
      if (existing) {
        // Already reported this name? skip
        if (issues.some((i) => i.name === name)) return;
        issues.push({
          name,
          firstLine: existing.line,
          secondLine: line,
          kind: existing.kind,
        });
      } else {
        seen.set(name, { line, kind });
      }
    };

    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        record(stmt.name.text, "function", lineOf(stmt));
      } else if (ts.isClassDeclaration(stmt) && stmt.name) {
        record(stmt.name.text, "class", lineOf(stmt));
      } else if (ts.isInterfaceDeclaration(stmt)) {
        // Interfaces can legitimately be re-opened/merged — skip
      } else if (ts.isTypeAliasDeclaration(stmt)) {
        record(stmt.name.text, "type", lineOf(stmt));
      } else if (ts.isEnumDeclaration(stmt)) {
        record(stmt.name.text, "enum", lineOf(stmt));
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            record(decl.name.text, "variable", lineOf(decl));
          }
        }
      }
    }

    return issues;
  } catch {
    return [];
  }
}

/** Render a duplicate issue as a short prompt-friendly string. */
export function formatDuplicateIssue(issue: DuplicateIssue): string {
  return `${issue.kind} '${issue.name}' is declared twice (lines ${issue.firstLine} and ${issue.secondLine}). Remove one declaration.`;
}

/**
 * List top-level declared symbols (function names, class names, type
 * names, enum names, const/let/var binding names) in a single source
 * file. Used to build cross-file "DO NOT REDECLARE" hints for the
 * developer prompt — the most common cross-file failure mode is
 * declaring the same helper (e.g. `countNeighbors`) in two files which
 * then collide when the preview HTML inlines siblings.
 *
 * Non-TS files: returns []. Parse failures: returns [] (never blocks).
 */
export function listTopLevelSymbols(
  filePath: string,
  content: string,
): string[] {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (!["ts", "tsx", "jsx", "js"].includes(ext)) return [];

  try {
    const isJsx = ext === "tsx" || ext === "jsx";
    const sourceFile = ts.createSourceFile(
      `__sym__.${ext}`,
      content,
      ts.ScriptTarget.ES2017,
      true,
      isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const names = new Set<string>();
    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        names.add(stmt.name.text);
      } else if (ts.isClassDeclaration(stmt) && stmt.name) {
        names.add(stmt.name.text);
      } else if (ts.isTypeAliasDeclaration(stmt)) {
        names.add(stmt.name.text);
      } else if (ts.isEnumDeclaration(stmt)) {
        names.add(stmt.name.text);
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
        }
      }
    }
    return Array.from(names);
  } catch {
    return [];
  }
}
