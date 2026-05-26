/**
 * AST-based undefined-identifier detector for LLM-generated TS/TSX.
 *
 * Catches the most common runtime failure that slips past `tsc` because
 * we deliberately ignore TS code 2304 (Cannot find name) — React/JSX
 * intrinsics + hooks produce too many false positives there.
 *
 * Strategy: walk the AST and collect
 *   (a) every NAME the file DECLARES (top-level + nested binding scopes,
 *       imports, function/method params, catch params, class members,
 *       JSX namespaces).
 *   (b) every NAME the file USES that should resolve to something —
 *       Identifier expressions and JSX tag identifiers — but excluding
 *       lowercase JSX tags (intrinsics like <div>), property access
 *       (`obj.foo` — foo is a property, not a binding), object property
 *       NAMES in literals (`{ foo: bar }` — foo is a property), and
 *       type positions (interface members, type params, etc.).
 *
 * A name is "ok" if:
 *   - it appears in the declared set
 *   - it is a known global (React, browser, JSX intrinsic, common util)
 *   - it begins with an uppercase letter AND it's used in a JSX position
 *     where it might be an imported component (we are conservative and
 *     skip — duplicate-check / TS will catch unknown component imports)
 *
 * Returns one issue per unresolved name (deduped). Non-TS files: []. Parse
 * failures: [] (never blocks the pipeline on an unexpected AST crash).
 */

import ts from "typescript";

export interface UndefIssue {
  name: string;
  line: number;
  /** "expression" for value-position refs, "jsx" for JSX tag names */
  kind: "expression" | "jsx";
}

/** Names that are always allowed (React, browser, JS globals, common). */
const GLOBALS = new Set<string>([
  // JS / browser globals
  "console",
  "window",
  "document",
  "globalThis",
  "Math",
  "Date",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  "RegExp",
  "Infinity",
  "NaN",
  "undefined",
  "null",
  "true",
  "false",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "localStorage",
  "sessionStorage",
  "fetch",
  "alert",
  "confirm",
  "prompt",
  "navigator",
  "location",
  "history",
  "URL",
  "URLSearchParams",
  "FormData",
  "Blob",
  "File",
  "FileReader",
  "Image",
  "Audio",
  "HTMLElement",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "structuredClone",
  "performance",
  "crypto",
  // React
  "React",
  "Fragment",
  // Test globals (a TSX file might be a .test.tsx)
  "describe",
  "it",
  "test",
  "expect",
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
  "vi",
  "jest",
  // Node-ish (rare but harmless)
  "process",
  "Buffer",
  "module",
  "require",
  "__dirname",
  "__filename",
]);

const REACT_HOOK_RE = /^use[A-Z]\w*$/;

export interface UndefCheckOptions {
  /** Extra names to treat as declared (e.g. globals injected by a runtime). */
  extraDeclared?: string[];
}

export function findUndefinedIdentifiers(
  filePath: string,
  content: string,
  opts: UndefCheckOptions = {},
): UndefIssue[] {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (!["ts", "tsx", "jsx", "js"].includes(ext)) return [];

  try {
    const isJsx = ext === "tsx" || ext === "jsx";
    const sourceFile = ts.createSourceFile(
      `__undef__.${ext}`,
      content,
      ts.ScriptTarget.ES2017,
      true,
      isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const declared = new Set<string>(opts.extraDeclared || []);

    // ── Pass 1: collect declared names everywhere ──
    const collect = (node: ts.Node) => {
      // Imports
      if (ts.isImportDeclaration(node) && node.importClause) {
        const c = node.importClause;
        if (c.name) declared.add(c.name.text); // default import
        if (c.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) {
            declared.add(c.namedBindings.name.text);
          } else {
            for (const spec of c.namedBindings.elements) {
              declared.add(spec.name.text);
            }
          }
        }
      }
      // Function / Method / Arrow / Constructor params
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
      ) {
        if (
          (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
          node.name
        ) {
          declared.add(node.name.text);
        }
        for (const p of node.parameters) collectBindingName(p.name);
      }
      // Function declarations as identifiers
      if (ts.isFunctionDeclaration(node) && node.name) {
        declared.add(node.name.text);
      }
      // Class declarations
      if (ts.isClassDeclaration(node) && node.name) {
        declared.add(node.name.text);
      }
      // Type alias / interface / enum
      if (ts.isTypeAliasDeclaration(node)) declared.add(node.name.text);
      if (ts.isInterfaceDeclaration(node)) declared.add(node.name.text);
      if (ts.isEnumDeclaration(node)) declared.add(node.name.text);
      // Variable declarations
      if (ts.isVariableDeclaration(node)) {
        collectBindingName(node.name);
      }
      // for/for-in/for-of bound names
      if (ts.isForStatement(node) && node.initializer) {
        if (ts.isVariableDeclarationList(node.initializer)) {
          for (const d of node.initializer.declarations)
            collectBindingName(d.name);
        }
      }
      if (
        (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
        ts.isVariableDeclarationList(node.initializer)
      ) {
        for (const d of node.initializer.declarations)
          collectBindingName(d.name);
      }
      // Catch clause
      if (ts.isCatchClause(node) && node.variableDeclaration) {
        collectBindingName(node.variableDeclaration.name);
      }
      ts.forEachChild(node, collect);
    };

    const collectBindingName = (name: ts.BindingName) => {
      if (ts.isIdentifier(name)) {
        declared.add(name.text);
      } else if (ts.isObjectBindingPattern(name)) {
        for (const el of name.elements) collectBindingName(el.name);
      } else if (ts.isArrayBindingPattern(name)) {
        for (const el of name.elements) {
          if (ts.isBindingElement(el)) collectBindingName(el.name);
        }
      }
    };

    collect(sourceFile);

    // ── Pass 2: collect used identifier references that should resolve ──
    const issues: UndefIssue[] = [];
    const seenKey = new Set<string>();

    const report = (name: string, node: ts.Node, kind: UndefIssue["kind"]) => {
      if (declared.has(name)) return;
      if (GLOBALS.has(name)) return;
      if (REACT_HOOK_RE.test(name)) return; // useFoo hooks (assume imported elsewhere or from React)
      // Uppercase-leading names in JSX position: assume might be component
      // imported in a different file. Be conservative — TS / dup-check will
      // catch true bogus components if they ever get instantiated.
      if (kind === "jsx" && /^[A-Z]/.test(name)) return;
      const line =
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          .line + 1;
      const key = `${name}@${line}`;
      if (seenKey.has(key)) return;
      seenKey.add(key);
      issues.push({ name, line, kind });
    };

    const isInTypePosition = (node: ts.Node): boolean => {
      let n: ts.Node | undefined = node.parent;
      while (n) {
        if (
          ts.isTypeNode(n) ||
          ts.isTypeReferenceNode(n) ||
          ts.isTypeAliasDeclaration(n) ||
          ts.isInterfaceDeclaration(n) ||
          ts.isTypeParameterDeclaration(n) ||
          ts.isTypeQueryNode(n) ||
          ts.isTypeOperatorNode(n)
        ) {
          return true;
        }
        // Stop at expression / statement boundaries
        if (ts.isStatement(n) || ts.isExpression(n)) return false;
        n = n.parent;
      }
      return false;
    };

    const visit = (node: ts.Node) => {
      // Identifier used as a value expression
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        if (!parent) {
          ts.forEachChild(node, visit);
          return;
        }
        // Skip declaration sites (already collected as declared)
        if (
          (ts.isFunctionDeclaration(parent) ||
            ts.isClassDeclaration(parent) ||
            ts.isInterfaceDeclaration(parent) ||
            ts.isTypeAliasDeclaration(parent) ||
            ts.isEnumDeclaration(parent) ||
            ts.isEnumMember(parent) ||
            ts.isVariableDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isBindingElement(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isPropertySignature(parent) ||
            ts.isImportSpecifier(parent) ||
            ts.isImportClause(parent) ||
            ts.isNamespaceImport(parent) ||
            ts.isExportSpecifier(parent) ||
            ts.isTypeParameterDeclaration(parent)) &&
          parent.name === node
        ) {
          return;
        }
        // Property access: foo in obj.foo is not a reference
        if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
          return;
        }
        // Optional property access: obj?.foo
        if (
          ts.isPropertyAccessExpression(parent) &&
          parent.questionDotToken &&
          parent.name === node
        ) {
          return;
        }
        // Object literal property NAME: { foo: bar } — only `foo` if shorthand `{ foo }` is a ref
        if (ts.isPropertyAssignment(parent) && parent.name === node) {
          return;
        }
        // Object binding element property name: const { foo: x } = obj → `foo` is property, x is binding
        if (ts.isBindingElement(parent) && parent.propertyName === node) {
          return;
        }
        // Method signature name in interface/class shorthand
        if (ts.isMethodSignature(parent) && parent.name === node) {
          return;
        }
        // Qualified name (Foo.Bar) — right side is not a ref
        if (ts.isQualifiedName(parent) && parent.right === node) return;
        // JSX attribute name (onClick={...}) — left identifier is attr, not a ref
        if (ts.isJsxAttribute(parent) && parent.name === node) return;
        // JSX tag name (the tagName slot of opening/closing/selfClosing) —
        // handled separately so we can distinguish intrinsic <div> from <Foo />.
        if (
          (ts.isJsxOpeningElement(parent) ||
            ts.isJsxClosingElement(parent) ||
            ts.isJsxSelfClosingElement(parent)) &&
          parent.tagName === node
        ) {
          return;
        }
        // JSX property access of namespace tag like <foo:bar /> rare — skip names
        // Labeled statement label / break/continue label
        if (
          (ts.isLabeledStatement(parent) ||
            ts.isBreakStatement(parent) ||
            ts.isContinueStatement(parent)) &&
          (parent as ts.LabeledStatement).label === node
        ) {
          return;
        }
        // Type positions
        if (isInTypePosition(node)) return;
        // Otherwise — it's a value reference
        report(node.text, node, "expression");
        return;
      }

      // JSX tag name (opening / self-closing). Lowercase = intrinsic, skip.
      if (
        ts.isJsxOpeningElement(node) ||
        ts.isJsxSelfClosingElement(node) ||
        ts.isJsxClosingElement(node)
      ) {
        const tag = node.tagName;
        if (ts.isIdentifier(tag)) {
          const name = tag.text;
          // Lowercase = HTML intrinsic
          if (/^[a-z]/.test(name)) {
            // skip — JSX intrinsic
          } else {
            report(name, tag, "jsx");
          }
        }
        // PropertyAccessExpression tag (e.g. <Foo.Bar/>) — check the head
        if (ts.isPropertyAccessExpression(tag)) {
          let head: ts.Expression = tag;
          while (ts.isPropertyAccessExpression(head)) head = head.expression;
          if (ts.isIdentifier(head)) {
            report(head.text, head, "jsx");
          }
        }
        // Visit children (attributes, expressions) normally
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return issues;
  } catch {
    return [];
  }
}

/** Render an undef issue as a short prompt-friendly string. */
export function formatUndefIssue(issue: UndefIssue): string {
  return `'${issue.name}' is used (line ${issue.line}) but never declared, imported, or defined as a parameter. Either add a declaration (e.g. const ${issue.name} = ..., function ${issue.name}() {...}, or useState) or remove the reference.`;
}
