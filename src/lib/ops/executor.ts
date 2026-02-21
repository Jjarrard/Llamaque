import {
  AppOperation,
  FileBundle,
  OperationExecution,
  OperationResult,
} from "@/lib/ops/types";

export function applyOperations(
  files: FileBundle,
  operations: AppOperation[],
): OperationResult {
  let nextFiles: FileBundle = { ...files };
  const executions: OperationExecution[] = [];

  for (const operation of operations) {
    const before = nextFiles;
    const after = applySingle(before, operation);
    nextFiles = after.files;
    executions.push({
      operation,
      applied: after.applied,
      reason: after.reason,
    });
  }

  // Post-process: ensure JS has DOMContentLoaded → initApp() if initApp exists
  if (
    nextFiles.js.includes("function initApp") &&
    !nextFiles.js.includes("DOMContentLoaded")
  ) {
    nextFiles = {
      ...nextFiles,
      js:
        nextFiles.js.trimEnd() +
        '\n\ndocument.addEventListener("DOMContentLoaded", initApp);\n',
    };
  }

  // Post-process: ensure JS file header comment
  if (nextFiles.js.trim().length > 0 && !nextFiles.js.startsWith("//")) {
    nextFiles = { ...nextFiles, js: "// script.js\n" + nextFiles.js };
  }

  // Post-process: ensure CSS file header comment
  if (nextFiles.css.trim().length > 0 && !nextFiles.css.startsWith("/*")) {
    nextFiles = { ...nextFiles, css: "/* style.css */\n" + nextFiles.css };
  }

  return { files: nextFiles, executions };
}

function applySingle(
  files: FileBundle,
  operation: AppOperation,
): { files: FileBundle; applied: boolean; reason?: string } {
  switch (operation.type) {
    case "ensureHtmlElement":
      return ensureHtmlElement(files, operation);
    case "ensureHtmlAttribute":
      return ensureHtmlAttribute(files, operation);
    case "ensureCssRule":
      return ensureCssRule(files, operation);
    case "ensureJsConst":
      return ensureJsConst(files, operation);
    case "ensureJsFunction":
      return ensureJsFunction(files, operation);
    case "ensureEventBinding":
      return ensureEventBinding(files, operation);
    default:
      return { files, applied: false, reason: "unsupported operation" };
  }
}

function ensureHtmlElement(
  files: FileBundle,
  operation: Extract<AppOperation, { type: "ensureHtmlElement" }>,
) {
  const html = files.html;
  if (operation.id) {
    const idRegex = new RegExp(`id=["']${escapeRegExp(operation.id)}["']`, "i");
    if (idRegex.test(html)) {
      return { files, applied: false, reason: "element already exists" };
    }
  }

  const attrs: string[] = [];
  if (operation.id) attrs.push(`id="${operation.id}"`);
  if (operation.className) attrs.push(`class="${operation.className}"`);
  const attrText = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
  const content = operation.text ?? "";
  const elementMarkup = `<${operation.tag}${attrText}>${content}</${operation.tag}>`;

  let nextHtml = html;
  if (operation.parentId) {
    const parentPattern = new RegExp(
      `(<[^>]*id=["']${escapeRegExp(operation.parentId)}["'][^>]*>)([\\s\\S]*?)(<\\/[^>]+>)`,
      "i",
    );
    if (parentPattern.test(nextHtml)) {
      nextHtml = nextHtml.replace(parentPattern, (_, open, inner, close) => {
        const trimmedInner = inner.trimEnd();
        const separator = trimmedInner.length > 0 ? "\n" : "";
        return `${open}${inner}${separator}  ${elementMarkup}\n${close}`;
      });
      return { files: { ...files, html: nextHtml }, applied: true };
    }
  }

  if (/<\/body>/i.test(nextHtml)) {
    nextHtml = nextHtml.replace(/<\/body>/i, `  ${elementMarkup}\n</body>`);
    return { files: { ...files, html: nextHtml }, applied: true };
  }

  nextHtml += `\n${elementMarkup}`;
  return { files: { ...files, html: nextHtml }, applied: true };
}

function ensureHtmlAttribute(
  files: FileBundle,
  operation: Extract<AppOperation, { type: "ensureHtmlAttribute" }>,
) {
  const targetPattern = new RegExp(
    `(<[^>]*id=["']${escapeRegExp(operation.targetId)}["'][^>]*>)`,
    "i",
  );
  const match = files.html.match(targetPattern);
  if (!match) {
    return { files, applied: false, reason: "target element not found" };
  }

  const tag = match[1];
  const attrPattern = new RegExp(
    `${escapeRegExp(operation.attribute)}=["'][^"']*["']`,
    "i",
  );
  const nextTag = attrPattern.test(tag)
    ? tag.replace(attrPattern, `${operation.attribute}="${operation.value}"`)
    : tag.replace(/>$/, ` ${operation.attribute}="${operation.value}">`);

  if (nextTag === tag) {
    return { files, applied: false, reason: "attribute unchanged" };
  }

  return {
    files: { ...files, html: files.html.replace(tag, nextTag) },
    applied: true,
  };
}

function ensureCssRule(
  files: FileBundle,
  operation: Extract<AppOperation, { type: "ensureCssRule" }>,
) {
  const selector = operation.selector.trim();
  if (!selector) return { files, applied: false, reason: "invalid selector" };

  const ruleRegex = new RegExp(
    `${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\}`,
    "i",
  );
  const found = files.css.match(ruleRegex);

  if (!found) {
    const declarations = formatDeclarations(operation.declarations);
    const rule = `\n${selector} {\n${declarations}\n}\n`;
    return {
      files: { ...files, css: `${files.css.trimEnd()}${rule}` },
      applied: true,
    };
  }

  const existingMap = parseDeclarations(found[1]);
  let changed = false;
  for (const [prop, value] of Object.entries(operation.declarations)) {
    if (existingMap[prop] !== value) {
      existingMap[prop] = value;
      changed = true;
    }
  }

  if (!changed)
    return { files, applied: false, reason: "rule already satisfied" };

  const merged = `${selector} {\n${formatDeclarations(existingMap)}\n}`;
  return {
    files: { ...files, css: files.css.replace(ruleRegex, merged) },
    applied: true,
  };
}

function ensureJsConst(
  files: FileBundle,
  operation: Extract<AppOperation, { type: "ensureJsConst" }>,
) {
  const name = operation.name.trim();
  if (!name) return { files, applied: false, reason: "invalid const name" };

  const declRegex = new RegExp(
    `\\b(?:const|let|var)\\s+${escapeRegExp(name)}\\b`,
  );
  if (declRegex.test(files.js)) {
    return { files, applied: false, reason: "const already declared" };
  }

  const line = `const ${name} = ${operation.valueExpression};`;
  return {
    files: { ...files, js: `${files.js.trimEnd()}\n${line}\n` },
    applied: true,
  };
}

function ensureJsFunction(
  files: FileBundle,
  operation: Extract<AppOperation, { type: "ensureJsFunction" }>,
) {
  const name = operation.name.trim();
  if (!name) return { files, applied: false, reason: "invalid function name" };

  const fnRegex = new RegExp(
    `(?:function\\s+${escapeRegExp(name)}\\s*\\(|(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=)`,
  );
  if (fnRegex.test(files.js)) {
    return { files, applied: false, reason: "function already exists" };
  }

  const args = (operation.args ?? []).join(", ");
  const fn = `\nfunction ${name}(${args}) {\n${indentBlock(operation.body.trim(), 2)}\n}\n`;
  return {
    files: { ...files, js: `${files.js.trimEnd()}${fn}` },
    applied: true,
  };
}

function ensureEventBinding(
  files: FileBundle,
  operation: Extract<AppOperation, { type: "ensureEventBinding" }>,
) {
  const existingBindingPattern = new RegExp(
    `getElementById\\(\\s*["']${escapeRegExp(operation.targetId)}["']\\s*\\)[\\s\\S]*?addEventListener\\(\\s*["']${escapeRegExp(operation.event)}["']\\s*,\\s*${escapeRegExp(operation.handlerName)}`,
    "i",
  );
  if (existingBindingPattern.test(files.js)) {
    return { files, applied: false, reason: "event binding already exists" };
  }

  const variableName = sanitizeIdentifier(
    `el_${operation.targetId}_${operation.event}`,
  );
  const snippet = [
    `const ${variableName} = document.getElementById("${operation.targetId}");`,
    `if (${variableName}) {`,
    `  ${variableName}.addEventListener("${operation.event}", ${operation.handlerName});`,
    `}`,
  ].join("\n");

  return {
    files: { ...files, js: `${files.js.trimEnd()}\n${snippet}\n` },
    applied: true,
  };
}

function parseDeclarations(block: string): Record<string, string> {
  const map: Record<string, string> = {};
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes(":"));

  for (const line of lines) {
    const normalized = line.endsWith(";") ? line.slice(0, -1) : line;
    const idx = normalized.indexOf(":");
    if (idx <= 0) continue;
    const prop = normalized.slice(0, idx).trim();
    const value = normalized.slice(idx + 1).trim();
    if (prop && value) map[prop] = value;
  }

  return map;
}

function formatDeclarations(declarations: Record<string, string>): string {
  return Object.entries(declarations)
    .map(([prop, value]) => `  ${prop}: ${value};`)
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indentBlock(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function sanitizeIdentifier(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[0-9]/.test(safe)) return `_${safe}`;
  return safe;
}
