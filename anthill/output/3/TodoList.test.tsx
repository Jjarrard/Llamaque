import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TodoList from "./TodoList";

describe("TodoList", () => {
  it("renders without crashing", () => {
    render(<TodoList />);
  });

  it("displays the add todo input and button", () => {
    render(<TodoList />);
    expect(screen.getByPlaceholderText(/add a new task/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add/i })).toBeInTheDocument();
  });

  it("accepts input and reflects typed value", () => {
    render(<TodoList />);
    const input = screen.getByPlaceholderText(/add a new task/i);
    fireEvent.change(input, { target: { value: "Test Todo" } });
    expect(input).toHaveValue("Test Todo");
  });

  it("adds a todo when the add button is clicked", () => {
    render(<TodoList />);
    const input = screen.getByPlaceholderText(/add a new task/i);
    fireEvent.change(input, { target: { value: "Test Todo" } });
    const addButton = screen.getByRole("button", { name: /add/i });
    fireEvent.click(addButton);
    expect(screen.getByText(/test todo/i)).toBeInTheDocument();
  });

  it("marks a todo as complete when the checkbox is clicked", () => {
    render(<TodoList />);
    const input = screen.getByPlaceholderText(/add a new task/i);
    fireEvent.change(input, { target: { value: "Test Todo" } });
    const addButton = screen.getByRole("button", { name: /add/i });
    fireEvent.click(addButton);
    const checkbox = screen.getByLabelText(/test todo/i);
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });
});