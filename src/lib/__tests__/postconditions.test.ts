import { describe, it, expect } from "vitest";
import {
  derivePostconditions,
  checkPostconditions,
  formatFailureMessage,
} from "@/lib/postconditions";

describe("postconditions", () => {
  describe("derivePostconditions", () => {
    it("derives an 'absent' check from 'remove signup screen'", () => {
      const conds = derivePostconditions("remove signup screen");
      // Either the full phrase or the bare target should be checked as absent.
      expect(conds.some((c) => c.kind === "absent")).toBe(true);
    });

    it("derives an 'absent' check for 'delete X' and 'drop X'", () => {
      expect(
        derivePostconditions("delete the footer").some(
          (c) => c.kind === "absent",
        ),
      ).toBe(true);
      expect(
        derivePostconditions("drop the navbar").some(
          (c) => c.kind === "absent",
        ),
      ).toBe(true);
    });

    it("derives 'absent' for old + 'present' for new on rename", () => {
      const conds = derivePostconditions("rename Login to SignIn");
      expect(
        conds.some((c) => c.kind === "absent" && /Login/i.test(c.needle)),
      ).toBe(true);
      expect(
        conds.some((c) => c.kind === "present" && /SignIn/i.test(c.needle)),
      ).toBe(true);
    });

    it("derives 'present' check for add/introduce/include", () => {
      const conds = derivePostconditions("add a dark mode toggle");
      expect(conds.some((c) => c.kind === "present")).toBe(true);
    });

    it("returns empty for instructions with no recognized verb", () => {
      const conds = derivePostconditions("be more thoughtful");
      expect(conds).toEqual([]);
    });
  });

  describe("checkPostconditions", () => {
    it("flags content that still contains an 'absent' needle", () => {
      const failures = checkPostconditions("function signup() {}", [
        { kind: "absent", needle: "signup", label: "remove signup" },
      ]);
      expect(failures.length).toBe(1);
      expect(failures[0].lineNumber).toBe(1);
    });

    it("passes when an 'absent' needle is gone", () => {
      const failures = checkPostconditions("function login() {}", [
        { kind: "absent", needle: "signup", label: "remove signup" },
      ]);
      expect(failures).toEqual([]);
    });

    it("flags content missing a 'present' needle", () => {
      const failures = checkPostconditions("nothing relevant here", [
        { kind: "present", needle: "DarkMode", label: "add DarkMode" },
      ]);
      expect(failures.length).toBe(1);
    });

    it("passes when a 'present' needle is found", () => {
      const failures = checkPostconditions("export function DarkMode() {}", [
        { kind: "present", needle: "DarkMode", label: "add DarkMode" },
      ]);
      expect(failures).toEqual([]);
    });

    it("reports line numbers correctly", () => {
      const content = "line1\nline2\nbadword\nline4";
      const failures = checkPostconditions(content, [
        { kind: "absent", needle: "badword", label: "remove" },
      ]);
      expect(failures[0].lineNumber).toBe(3);
    });

    it("ignores matches inside // line comments (ts)", () => {
      const failures = checkPostconditions(
        "// signup form goes here\nconst x = 1;\n",
        [{ kind: "absent", needle: "signup", label: "rm signup" }],
        "foo.ts",
      );
      expect(failures).toEqual([]);
    });

    it("ignores matches inside /* block */ comments (ts)", () => {
      const failures = checkPostconditions(
        "const x = 1;\n/* signup section */\nconst y = 2;\n",
        [{ kind: "absent", needle: "signup", label: "rm signup" }],
        "foo.tsx",
      );
      expect(failures).toEqual([]);
    });

    it("ignores matches inside # line comments (py)", () => {
      const failures = checkPostconditions(
        "# signup helper\nx = 1\n",
        [{ kind: "absent", needle: "signup", label: "rm signup" }],
        "foo.py",
      );
      expect(failures).toEqual([]);
    });

    it("still flags matches in string literals", () => {
      const failures = checkPostconditions(
        'const label = "Sign up";\n',
        [{ kind: "absent", needle: "sign up", label: "rm sign up" }],
        "foo.ts",
      );
      expect(failures.length).toBe(1);
    });

    it("ignores matches inside <!-- html comments -->", () => {
      const failures = checkPostconditions(
        "<div>ok</div>\n<!-- signup widget -->\n",
        [{ kind: "absent", needle: "signup", label: "rm signup" }],
        "foo.html",
      );
      expect(failures).toEqual([]);
    });
  });

  describe("formatFailureMessage", () => {
    it("returns empty string for no failures", () => {
      expect(formatFailureMessage([])).toBe("");
    });

    it("numbers multiple failures", () => {
      const msg = formatFailureMessage([
        {
          condition: { kind: "absent", needle: "a", label: "a" },
          lineNumber: 1,
          excerpt: "foo",
          message: "first",
        },
        {
          condition: { kind: "absent", needle: "b", label: "b" },
          lineNumber: 2,
          excerpt: "bar",
          message: "second",
        },
      ]);
      expect(msg).toMatch(/1\./);
      expect(msg).toMatch(/2\./);
    });
  });
});
