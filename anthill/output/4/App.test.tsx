import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import IdeasWall from "./IdeasWall";

describe("IdeasWall", () => {
  it("renders without crashing", () => {
    render(<IdeasWall />);
  });

  it("displays the 'Create New Idea' button", () => {
    render(<IdeasWall />);
    expect(screen.getByText(/create new idea/i)).toBeInTheDocument();
  });

  it("opens the modal when 'Submit Idea' is clicked", async () => {
    render(<IdeasWall />);
    fireEvent.click(screen.getByText(/submit idea/i));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("accepts input in the idea text box", async () => {
    render(<IdeasWall />);
    fireEvent.click(screen.getByText(/submit idea/i));
    const input = await screen.findByPlaceholderText(/enter your idea/i);
    fireEvent.change(input, { target: { value: "Test Idea" } });
    expect(input).toHaveValue("Test Idea");
  });

  it("displays the submitted idea after submission", async () => {
    render(<IdeasWall />);
    fireEvent.click(screen.getByText(/submit idea/i));
    const input = await screen.findByPlaceholderText(/enter your idea/i);
    fireEvent.change(input, { target: { value: "Test Idea" } });
    fireEvent.click(await screen.findByText(/submit/i));
    expect(await screen.findByText(/test idea/i)).toBeInTheDocument();
  });
});