export type FileBundle = {
  html: string;
  css: string;
  js: string;
};

export type HtmlEnsureElementOp = {
  type: "ensureHtmlElement";
  tag: string;
  id?: string;
  className?: string;
  text?: string;
  parentId?: string;
};

export type HtmlEnsureAttributeOp = {
  type: "ensureHtmlAttribute";
  targetId: string;
  attribute: string;
  value: string;
};

export type CssEnsureRuleOp = {
  type: "ensureCssRule";
  selector: string;
  declarations: Record<string, string>;
};

export type JsEnsureConstOp = {
  type: "ensureJsConst";
  name: string;
  valueExpression: string;
};

export type JsEnsureFunctionOp = {
  type: "ensureJsFunction";
  name: string;
  args?: string[];
  body: string;
};

export type JsEnsureEventBindingOp = {
  type: "ensureEventBinding";
  targetId: string;
  event: string;
  handlerName: string;
};

export type AppOperation =
  | HtmlEnsureElementOp
  | HtmlEnsureAttributeOp
  | CssEnsureRuleOp
  | JsEnsureConstOp
  | JsEnsureFunctionOp
  | JsEnsureEventBindingOp;

export type OperationExecution = {
  operation: AppOperation;
  applied: boolean;
  reason?: string;
};

export type OperationResult = {
  files: FileBundle;
  executions: OperationExecution[];
};
