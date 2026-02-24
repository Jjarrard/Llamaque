import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PollCreationForm from "./PollCreationForm";

describe("PollCreationForm", () => {
  it("renders without crashing", () => {
    render(<PollCreationForm />);
  });

  it("displays the poll creation form elements", () => {
    render(<PollCreationForm />);
    expect(screen.getByLabelText(/question/i)).toBeInTheDocument();
    expect(screen.getByText(/add option/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit/i })).toBeInTheDocument();
  });

  it("allows adding a new option", () => {
    render(<PollCreationForm />);
    fireEvent.click(screen.getByText(/add option/i));
    expect(screen.getAllByLabelText(/option/i)).toHaveLength(2);
  });
});