import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TodoApp from "./TodoApp";

describe("TodoApp", () => {
  it("renders without crashing", () => {
    render(<TodoApp />);
  });

  it("displays the welcome screen with title and buttons", () => {
    render(<TodoApp />);
    expect(screen.getByText(/welcome to todo app/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dark mode/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /neon outlines/i })).toBeInTheDocument();
  });

  it("allows user to type into the input field and see the value change", () => {
    render(<TodoApp />);
    const input = screen.getByPlaceholderText(/add a new todo/i);
    fireEvent.change(input, { target: { value: "Test Todo" } });
    expect(input).toHaveValue("Test Todo");
  });

  it("adds a new todo when the add button is clicked", () => {
    render(<TodoApp />);
    const input = screen.getByPlaceholderText(/add a new todo/i);
    fireEvent.change(input, { target: { value: "Test Todo" } });
    const addButton = screen.getByRole("button", { name: /add/i });
    fireEvent.click(addButton);
    expect(screen.getByText(/test todo/i)).toBeInTheDocument();
  });

  it("marks a todo as complete when the checkbox is clicked", () => {
    render(<TodoApp />);
    const input = screen.getByPlaceholderText(/add a new todo/i);
    fireEvent.change(input, { target: { value: "Test Todo" } });
    const addButton = screen.getByRole("button", { name: /add/i });
    fireEvent.click(addButton);
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });
});