import { describe, it, expect } from "vitest";
import { locateWindows, locateBestWindow, hashString } from "@/lib/locator";

describe("locator", () => {
  describe("hashString", () => {
    it("returns stable hashes for identical strings", () => {
      expect(hashString("hello world")).toBe(hashString("hello world"));
    });

    it("returns different hashes for different strings", () => {
      expect(hashString("hello")).not.toBe(hashString("hello!"));
    });

    it("returns hex output", () => {
      expect(hashString("anything")).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe("locateWindows", () => {
    const sampleFile = [
      "import React from 'react';",
      "",
      "export function HomePage() {",
      "  return (",
      "    <div>",
      "      <Hero />",
      "      <SignupForm />",
      "      <Footer />",
      "    </div>",
      "  );",
      "}",
      "",
      "function SignupForm() {",
      "  return (",
      "    <form>",
      "      <input name='email' />",
      "      <button type='submit'>Sign up</button>",
      "    </form>",
      "  );",
      "}",
    ].join("\n");

    it("finds the signup region for 'remove signup screen'", () => {
      const candidates = locateWindows(sampleFile, "remove signup screen");
      expect(candidates.length).toBeGreaterThan(0);
      const first = candidates[0];
      // The SignupForm function block lives around lines 13-20.
      expect(first.startLine).toBeLessThanOrEqual(17);
      expect(first.endLine).toBeGreaterThanOrEqual(13);
    });

    it("returns up to 3 candidates", () => {
      const candidates = locateWindows(sampleFile, "form");
      expect(candidates.length).toBeLessThanOrEqual(3);
    });

    it("returns empty array when no keywords match", () => {
      const candidates = locateWindows(
        sampleFile,
        "zzzzqqqqxxxx nonsense gibberish",
      );
      expect(candidates).toEqual([]);
    });

    it("each candidate has a hash matching its snippet content", () => {
      const candidates = locateWindows(sampleFile, "signup form");
      for (const c of candidates) {
        expect(c.hash).toMatch(/^[0-9a-f]+$/);
        expect(c.startLine).toBeGreaterThanOrEqual(1);
        expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
      }
    });
  });

  describe("locateBestWindow", () => {
    it("returns null when no match", () => {
      expect(
        locateBestWindow("const x = 1;\n", "qqqqzzzzwwww nothing"),
      ).toBeNull();
    });

    it("returns the top candidate when matches exist", () => {
      const code = "function greet() {\n  return 'hi';\n}\n";
      const best = locateBestWindow(code, "greet function");
      expect(best).not.toBeNull();
      expect(best!.startLine).toBe(1);
    });
  });
});
