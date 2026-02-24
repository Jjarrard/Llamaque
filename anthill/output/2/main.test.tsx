import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PlanDisplay from "./PlanDisplay";

describe("PlanDisplay", () => {
  it("renders without crashing", () => {
    const mockPlan = {
      name: "Test Plan",
      description: "Test description",
      startDate: "2023-01-01",
      endDate: "2023-12-31",
      progress: 75
    };
    render(<PlanDisplay plan={mockPlan} />);
    expect(screen.getByText("Test Plan")).toBeInTheDocument();
    expect(screen.getByText("75% complete")).toBeInTheDocument();
  });
});