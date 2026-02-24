import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TodoItem from "./TodoItem";

describe("TodoItem", () => {
  const todo = { id: 1, text: "Test Todo", completed: false };

  it("renders without crashing", () => {
    render(<TodoItem todo={todo} />);
  });

  it("displays the todo text", () => {
    render(<TodoItem todo={todo} />);
    expect(screen.getByText(todo.text)).toBeInTheDocument();
  });

  it("allows editing the todo text", () => {
    render(<TodoItem todo={todo} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Updated Todo" } });
    expect(input).toHaveValue("Updated Todo");
  });

  it("marks the todo as completed when checkbox is checked", () => {
    render(<TodoItem todo={todo} />);
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it("removes the todo when delete button is clicked", () => {
    const handleRemove = vitest.fn();
    render(<TodoItem todo={todo} onRemove={handleRemove} />);
    const removeButton = screen.getByText(/remove/i);
    fireEvent.click(removeButton);
    expect(handleRemove).toHaveBeenCalledWith(todo.id);
  });
});