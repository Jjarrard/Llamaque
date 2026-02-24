import { AppOperation } from "@/lib/ops/types";

/**
 * Compile natural-language requirements into deterministic operations.
 *
 * For the React TSX component model, deterministic ops are not used —
 * the LLM generates the complete component. This compiler returns an
 * empty list which the pipeline handles gracefully (skips the pre-pass).
 *
 * The HTML/CSS/JS-specific compilation functions are retained below
 * but not invoked for Component.tsx files.
 */
export function compileRequirementsToOperations(
  filePath: string,
  requirements: string[],
  projectName: string,
): AppOperation[] {
  const ops: AppOperation[] = [];
  const joined = requirements.join(" ").toLowerCase();

  // TSX component files — no deterministic pre-pass, LLM handles everything
  if (filePath === "Component.tsx" || filePath.endsWith(".tsx")) {
    return ops;
  }

  if (filePath === "index.html") {
    compileHtmlOps(ops, joined, projectName);
  } else if (filePath === "style.css") {
    compileCssOps(ops, joined, projectName);
  } else if (filePath === "script.js") {
    compileJsOps(ops, joined, projectName);
  }

  return ops;
}

// ──────────────────────────────────────────────
//  HTML OPERATIONS
// ──────────────────────────────────────────────

function compileHtmlOps(
  ops: AppOperation[],
  joined: string,
  projectName: string,
) {
  // Always: app container + title
  ops.push({ type: "ensureHtmlElement", tag: "main", id: "app" });
  ops.push({
    type: "ensureHtmlElement",
    tag: "h1",
    id: "appTitle",
    text: projectName,
    parentId: "app",
  });

  // Form + input
  if (
    hasAny(joined, [
      "form",
      "input",
      "add",
      "create",
      "search",
      "submit",
      "new",
      "enter",
    ])
  ) {
    ops.push({
      type: "ensureHtmlElement",
      tag: "form",
      id: "primaryForm",
      parentId: "app",
    });
    ops.push({
      type: "ensureHtmlElement",
      tag: "input",
      id: "primaryInput",
      parentId: "primaryForm",
    });
    ops.push({
      type: "ensureHtmlAttribute",
      targetId: "primaryInput",
      attribute: "type",
      value: "text",
    });
    ops.push({
      type: "ensureHtmlAttribute",
      targetId: "primaryInput",
      attribute: "placeholder",
      value: `Enter ${projectName.toLowerCase().replace(/app$/i, "").trim() || "item"}...`,
    });
  }

  // Date/due-date input
  if (hasAny(joined, ["date", "due", "deadline", "schedule"])) {
    ops.push({
      type: "ensureHtmlElement",
      tag: "input",
      id: "dueDateInput",
      parentId: hasAny(joined, ["form"]) ? "primaryForm" : "app",
    });
    ops.push({
      type: "ensureHtmlAttribute",
      targetId: "dueDateInput",
      attribute: "type",
      value: "date",
    });
  }

  // Priority / category dropdown
  if (
    hasAny(joined, [
      "priority",
      "level",
      "category",
      "type",
      "dropdown",
      "select",
    ])
  ) {
    ops.push({
      type: "ensureHtmlElement",
      tag: "select",
      id: "priorityDropdown",
      parentId: hasAny(joined, ["form"]) ? "primaryForm" : "app",
    });
  }

  // Submit / action button
  if (
    hasAny(joined, [
      "button",
      "submit",
      "save",
      "add",
      "toggle",
      "click",
      "create",
      "new",
    ])
  ) {
    const buttonParent = hasAny(joined, ["form", "input"])
      ? "primaryForm"
      : "app";
    ops.push({
      type: "ensureHtmlElement",
      tag: "button",
      id: "primaryActionButton",
      text: hasAny(joined, ["add", "create", "new"]) ? "Add" : "Submit",
      parentId: buttonParent,
    });
    ops.push({
      type: "ensureHtmlAttribute",
      targetId: "primaryActionButton",
      attribute: "type",
      value: "submit",
    });
  }

  // Filter / view controls
  if (
    hasAny(joined, ["filter", "view", "active", "completed", "all", "show"])
  ) {
    ops.push({
      type: "ensureHtmlElement",
      tag: "div",
      id: "filterControls",
      parentId: "app",
    });
  }

  // List container
  if (
    hasAny(joined, [
      "list",
      "items",
      "results",
      "tasks",
      "cards",
      "entries",
      "todos",
    ])
  ) {
    ops.push({
      type: "ensureHtmlElement",
      tag: "ul",
      id: "itemsList",
      parentId: "app",
    });
  }

  // Status/counter display
  if (
    hasAny(joined, [
      "count",
      "counter",
      "score",
      "total",
      "status",
      "remaining",
    ])
  ) {
    ops.push({
      type: "ensureHtmlElement",
      tag: "div",
      id: "statusDisplay",
      parentId: "app",
    });
  }
}

// ──────────────────────────────────────────────
//  CSS OPERATIONS
// ──────────────────────────────────────────────

function compileCssOps(
  ops: AppOperation[],
  joined: string,
  _projectName: string,
) {
  // Base reset + layout
  ops.push({
    type: "ensureCssRule",
    selector: "*",
    declarations: {
      "box-sizing": "border-box",
      margin: "0",
      padding: "0",
    },
  });

  ops.push({
    type: "ensureCssRule",
    selector: "body",
    declarations: {
      "font-family":
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      "line-height": "1.6",
      "background-color": "#f5f5f5",
      color: "#333",
      "min-height": "100vh",
    },
  });

  ops.push({
    type: "ensureCssRule",
    selector: "#app",
    declarations: {
      "max-width": "640px",
      margin: "2rem auto",
      padding: "2rem",
      "background-color": "#fff",
      "border-radius": "12px",
      "box-shadow": "0 2px 8px rgba(0,0,0,0.1)",
    },
  });

  ops.push({
    type: "ensureCssRule",
    selector: "#appTitle",
    declarations: {
      "font-size": "1.8rem",
      "margin-bottom": "1.5rem",
      color: "#222",
      "text-align": "center",
    },
  });

  // Form styling
  if (hasAny(joined, ["form", "input", "add", "create", "search", "submit"])) {
    ops.push({
      type: "ensureCssRule",
      selector: "#primaryForm",
      declarations: {
        display: "flex",
        gap: "0.5rem",
        "margin-bottom": "1.5rem",
        "flex-wrap": "wrap",
      },
    });

    ops.push({
      type: "ensureCssRule",
      selector: 'input[type="text"]',
      declarations: {
        flex: "1",
        padding: "0.6rem 0.8rem",
        border: "1px solid #ddd",
        "border-radius": "8px",
        "font-size": "1rem",
        outline: "none",
        transition: "border-color 0.2s",
      },
    });

    ops.push({
      type: "ensureCssRule",
      selector: 'input[type="text"]:focus',
      declarations: {
        "border-color": "#4a90d9",
        "box-shadow": "0 0 0 2px rgba(74,144,217,0.2)",
      },
    });
  }

  // Select / dropdown
  if (hasAny(joined, ["select", "dropdown", "priority", "category"])) {
    ops.push({
      type: "ensureCssRule",
      selector: "select",
      declarations: {
        padding: "0.6rem 0.8rem",
        border: "1px solid #ddd",
        "border-radius": "8px",
        "font-size": "0.9rem",
        "background-color": "#fff",
      },
    });
  }

  // Date input
  if (hasAny(joined, ["date", "due", "deadline"])) {
    ops.push({
      type: "ensureCssRule",
      selector: 'input[type="date"]',
      declarations: {
        padding: "0.6rem 0.8rem",
        border: "1px solid #ddd",
        "border-radius": "8px",
        "font-size": "0.9rem",
      },
    });
  }

  // Button styling
  if (
    hasAny(joined, ["button", "click", "submit", "action", "add", "create"])
  ) {
    ops.push({
      type: "ensureCssRule",
      selector: "button",
      declarations: {
        padding: "0.6rem 1.2rem",
        border: "none",
        "border-radius": "8px",
        "background-color": "#4a90d9",
        color: "#fff",
        "font-size": "1rem",
        cursor: "pointer",
        transition: "background-color 0.2s, transform 0.1s",
      },
    });

    ops.push({
      type: "ensureCssRule",
      selector: "button:hover",
      declarations: {
        "background-color": "#357abd",
        transform: "translateY(-1px)",
      },
    });

    ops.push({
      type: "ensureCssRule",
      selector: "button:active",
      declarations: {
        transform: "translateY(0)",
      },
    });
  }

  // List styling
  if (
    hasAny(joined, ["list", "items", "tasks", "results", "todos", "entries"])
  ) {
    ops.push({
      type: "ensureCssRule",
      selector: "#itemsList",
      declarations: {
        "list-style": "none",
        padding: "0",
        margin: "0",
      },
    });

    ops.push({
      type: "ensureCssRule",
      selector: "#itemsList li",
      declarations: {
        display: "flex",
        "align-items": "center",
        gap: "0.5rem",
        padding: "0.8rem",
        "border-bottom": "1px solid #eee",
        transition: "background-color 0.2s",
      },
    });

    ops.push({
      type: "ensureCssRule",
      selector: "#itemsList li:hover",
      declarations: {
        "background-color": "#f9f9f9",
      },
    });

    // Completed item styling
    if (
      hasAny(joined, ["complete", "done", "toggle", "check", "mark", "finish"])
    ) {
      ops.push({
        type: "ensureCssRule",
        selector: "#itemsList li.completed",
        declarations: {
          opacity: "0.6",
          "text-decoration": "line-through",
        },
      });

      ops.push({
        type: "ensureCssRule",
        selector: "#itemsList li.completed span",
        declarations: {
          "text-decoration": "line-through",
          color: "#999",
        },
      });
    }
  }

  // Priority colors
  if (hasAny(joined, ["priority", "level", "urgent", "important"])) {
    ops.push({
      type: "ensureCssRule",
      selector: ".priority-high",
      declarations: {
        "border-left": "4px solid #e74c3c",
      },
    });

    ops.push({
      type: "ensureCssRule",
      selector: ".priority-medium",
      declarations: {
        "border-left": "4px solid #f39c12",
      },
    });

    ops.push({
      type: "ensureCssRule",
      selector: ".priority-low",
      declarations: {
        "border-left": "4px solid #27ae60",
      },
    });
  }

  // Filter controls
  if (hasAny(joined, ["filter", "view", "active", "show", "tab"])) {
    ops.push({
      type: "ensureCssRule",
      selector: "#filterControls",
      declarations: {
        display: "flex",
        gap: "0.5rem",
        "margin-bottom": "1rem",
      },
    });

    ops.push({
      type: "ensureCssRule",
      selector: "#filterControls button",
      declarations: {
        "background-color": "transparent",
        color: "#666",
        border: "1px solid #ddd",
        "font-size": "0.85rem",
        padding: "0.4rem 0.8rem",
      },
    });

    ops.push({
      type: "ensureCssRule",
      selector: "#filterControls button.active",
      declarations: {
        "background-color": "#4a90d9",
        color: "#fff",
        "border-color": "#4a90d9",
      },
    });
  }

  // Status / counter display
  if (
    hasAny(joined, [
      "count",
      "counter",
      "status",
      "remaining",
      "total",
      "score",
    ])
  ) {
    ops.push({
      type: "ensureCssRule",
      selector: "#statusDisplay",
      declarations: {
        "text-align": "center",
        "margin-top": "1rem",
        "font-size": "0.9rem",
        color: "#888",
      },
    });
  }

  // Delete / remove button inside list items
  if (hasAny(joined, ["remove", "delete", "trash", "clear"])) {
    ops.push({
      type: "ensureCssRule",
      selector: ".delete-btn",
      declarations: {
        "margin-left": "auto",
        background: "none",
        border: "none",
        color: "#e74c3c",
        cursor: "pointer",
        "font-size": "1rem",
        padding: "0.2rem 0.5rem",
      },
    });

    ops.push({
      type: "ensureCssRule",
      selector: ".delete-btn:hover",
      declarations: {
        "background-color": "#fdecea",
        "border-radius": "4px",
      },
    });
  }
}

// ──────────────────────────────────────────────
//  JAVASCRIPT OPERATIONS
// ──────────────────────────────────────────────

function compileJsOps(
  ops: AppOperation[],
  joined: string,
  _projectName: string,
) {
  // Determine what kind of app this is to generate appropriate logic
  const isList = hasAny(joined, [
    "list",
    "items",
    "tasks",
    "todos",
    "entries",
    "cards",
  ]);
  const hasAdd = hasAny(joined, ["add", "create", "new", "insert", "enter"]);
  const hasRemove = hasAny(joined, ["remove", "delete", "clear", "trash"]);
  const hasToggle = hasAny(joined, [
    "toggle",
    "complete",
    "done",
    "check",
    "mark",
    "finish",
  ]);
  const hasFilter = hasAny(joined, ["filter", "view", "active", "show", "all"]);
  const hasPriority = hasAny(joined, [
    "priority",
    "level",
    "urgent",
    "important",
  ]);
  const hasDate = hasAny(joined, ["date", "due", "deadline"]);
  const hasCount = hasAny(joined, [
    "count",
    "counter",
    "score",
    "total",
    "remaining",
  ]);

  // ── State ──
  if (isList) {
    ops.push({
      type: "ensureJsConst",
      name: "appState",
      valueExpression: '{ items: [], filter: "all", nextId: 1 }',
    });
  } else if (hasCount) {
    ops.push({
      type: "ensureJsConst",
      name: "appState",
      valueExpression: "{ count: 0 }",
    });
  } else {
    ops.push({
      type: "ensureJsConst",
      name: "appState",
      valueExpression: "{}",
    });
  }

  // ── Render function ──
  if (isList) {
    const renderLines: string[] = [
      'var list = document.getElementById("itemsList");',
      "if (!list) return;",
      'list.innerHTML = "";',
      "var items = appState.items;",
    ];

    if (hasFilter) {
      renderLines.push(
        'if (appState.filter === "active") items = items.filter(function(i) { return !i.done; });',
        'if (appState.filter === "completed") items = items.filter(function(i) { return i.done; });',
      );
    }

    renderLines.push(
      "items.forEach(function(item) {",
      '  var li = document.createElement("li");',
    );

    if (hasPriority) {
      renderLines.push(
        '  if (item.priority) li.className = "priority-" + item.priority;',
      );
    }

    if (hasToggle) {
      renderLines.push('  if (item.done) li.classList.add("completed");');
    }

    // Checkbox for toggle
    if (hasToggle) {
      renderLines.push(
        '  var cb = document.createElement("input");',
        '  cb.type = "checkbox";',
        "  cb.checked = item.done;",
        '  cb.addEventListener("change", function() { toggleItem(item.id); });',
        "  li.appendChild(cb);",
      );
    }

    // Text span
    renderLines.push(
      '  var span = document.createElement("span");',
      "  span.textContent = item.text;",
    );
    if (hasDate) {
      renderLines.push(
        '  if (item.date) span.textContent += " (" + item.date + ")";',
      );
    }
    renderLines.push("  li.appendChild(span);");

    // Delete button
    if (hasRemove) {
      renderLines.push(
        '  var delBtn = document.createElement("button");',
        '  delBtn.textContent = "\\u00D7";',
        '  delBtn.className = "delete-btn";',
        '  delBtn.addEventListener("click", function() { removeItem(item.id); });',
        "  li.appendChild(delBtn);",
      );
    }

    renderLines.push("  list.appendChild(li);", "});");

    // Status display
    if (hasCount || hasFilter) {
      renderLines.push(
        'var status = document.getElementById("statusDisplay");',
        "if (status) {",
        "  var active = appState.items.filter(function(i) { return !i.done; }).length;",
        '  status.textContent = active + " item" + (active !== 1 ? "s" : "") + " remaining";',
        "}",
      );
    }

    ops.push({
      type: "ensureJsFunction",
      name: "renderItems",
      body: renderLines.join("\n"),
    });
  }

  // ── Add / create handler ──
  if (hasAdd && isList) {
    const addLines: string[] = [
      "if (event) event.preventDefault();",
      'var input = document.getElementById("primaryInput");',
      "if (!input || !input.value.trim()) return;",
      "var newItem = { id: appState.nextId++, text: input.value.trim(), done: false };",
    ];

    if (hasPriority) {
      addLines.push(
        'var sel = document.getElementById("priorityDropdown");',
        'newItem.priority = sel ? sel.value : "low";',
      );
    }

    if (hasDate) {
      addLines.push(
        'var dateInput = document.getElementById("dueDateInput");',
        'newItem.date = dateInput ? dateInput.value : "";',
      );
    }

    addLines.push(
      "appState.items.push(newItem);",
      'input.value = "";',
      "renderItems();",
    );

    ops.push({
      type: "ensureJsFunction",
      name: "handlePrimaryAction",
      args: ["event"],
      body: addLines.join("\n"),
    });
  } else {
    // Generic handler — prevents form default
    ops.push({
      type: "ensureJsFunction",
      name: "handlePrimaryAction",
      args: ["event"],
      body: "if (event) event.preventDefault();",
    });
  }

  // ── Toggle / complete ──
  if (hasToggle && isList) {
    ops.push({
      type: "ensureJsFunction",
      name: "toggleItem",
      args: ["id"],
      body: [
        "appState.items.forEach(function(item) {",
        "  if (item.id === id) item.done = !item.done;",
        "});",
        "renderItems();",
      ].join("\n"),
    });
  }

  // ── Remove / delete ──
  if (hasRemove && isList) {
    ops.push({
      type: "ensureJsFunction",
      name: "removeItem",
      args: ["id"],
      body: [
        "appState.items = appState.items.filter(function(item) { return item.id !== id; });",
        "renderItems();",
      ].join("\n"),
    });
  }

  // ── Filter ──
  if (hasFilter && isList) {
    ops.push({
      type: "ensureJsFunction",
      name: "setFilter",
      args: ["filterValue"],
      body: [
        "appState.filter = filterValue;",
        'var buttons = document.querySelectorAll("#filterControls button");',
        "buttons.forEach(function(btn) {",
        '  btn.classList.toggle("active", btn.dataset.filter === filterValue);',
        "});",
        "renderItems();",
      ].join("\n"),
    });
  }

  // ── Init function ──
  if (isList) {
    const initLines: string[] = [];

    if (hasFilter) {
      initLines.push(
        'var filterContainer = document.getElementById("filterControls");',
        "if (filterContainer) {",
        '  ["all", "active", "completed"].forEach(function(f) {',
        '    var btn = document.createElement("button");',
        "    btn.textContent = f.charAt(0).toUpperCase() + f.slice(1);",
        "    btn.dataset.filter = f;",
        '    if (f === "all") btn.classList.add("active");',
        '    btn.addEventListener("click", function() { setFilter(f); });',
        "    filterContainer.appendChild(btn);",
        "  });",
        "}",
      );
    }

    initLines.push("renderItems();");

    ops.push({
      type: "ensureJsFunction",
      name: "initApp",
      body: initLines.join("\n"),
    });
  } else {
    ops.push({
      type: "ensureJsFunction",
      name: "initApp",
      body: [
        'var root = document.getElementById("app");',
        "if (!root) return;",
      ].join("\n"),
    });
  }

  // ── Event bindings ──
  if (
    hasAny(joined, [
      "button",
      "submit",
      "add",
      "toggle",
      "click",
      "create",
      "form",
    ])
  ) {
    ops.push({
      type: "ensureEventBinding",
      targetId: "primaryForm",
      event: "submit",
      handlerName: "handlePrimaryAction",
    });
  }
}

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}
