import { describe, it, expect } from "vitest";
import {
  inferParamsB,
  inferTier,
  inferVision,
  modelCapabilities,
} from "@/lib/model-capabilities";

describe("inferParamsB", () => {
  it("extracts explicit Nb tags", () => {
    expect(inferParamsB("llama3.2:3b")).toBe(3);
    expect(inferParamsB("qwen2.5:7b")).toBe(7);
    expect(inferParamsB("gemma3:12b")).toBe(12);
    expect(inferParamsB("llama3.2:1b")).toBe(1);
  });

  it("handles Gemma 'effective' sizes", () => {
    expect(inferParamsB("gemma4:e4b")).toBe(8);
    expect(inferParamsB("gemma3:e2b")).toBe(5);
  });

  it("falls back to family defaults for :latest", () => {
    expect(inferParamsB("llama3.2:latest")).toBe(3);
    expect(inferParamsB("llama3.1:latest")).toBe(8);
    expect(inferParamsB("qwen2.5:latest")).toBe(7);
  });

  it("returns 0 for unknown models", () => {
    expect(inferParamsB("totally-fake:weird")).toBe(0);
  });
});

describe("inferTier", () => {
  it("classifies by params", () => {
    expect(inferTier(0)).toBe("small");
    expect(inferTier(3)).toBe("small");
    expect(inferTier(4)).toBe("small");
    expect(inferTier(7)).toBe("medium");
    expect(inferTier(8)).toBe("medium");
    expect(inferTier(12)).toBe("large");
  });
});

describe("inferVision", () => {
  it("detects vision-capable families", () => {
    expect(inferVision("gemma4:e4b")).toBe(true);
    expect(inferVision("gemma3:12b")).toBe(true);
    expect(inferVision("llava:7b")).toBe(true);
    expect(inferVision("llama3.2-vision:11b")).toBe(true);
  });

  it("returns false for text-only models", () => {
    expect(inferVision("llama3.2:3b")).toBe(false);
    expect(inferVision("qwen2.5:7b")).toBe(false);
    expect(inferVision("phi3:mini")).toBe(false);
  });
});

describe("modelCapabilities", () => {
  it("returns aggregate caps for tiny llama", () => {
    const c = modelCapabilities("llama3.2:3b");
    expect(c.tier).toBe("small");
    expect(c.maxFiles).toBe(2);
    expect(c.vision).toBe(false);
  });

  it("returns aggregate caps for gemma e4b", () => {
    const c = modelCapabilities("gemma4:e4b");
    expect(c.tier).toBe("medium");
    expect(c.maxFiles).toBe(4);
    expect(c.vision).toBe(true);
  });

  it("returns aggregate caps for a large model", () => {
    const c = modelCapabilities("gemma3:27b");
    expect(c.tier).toBe("large");
    expect(c.maxFiles).toBe(6);
  });
});
