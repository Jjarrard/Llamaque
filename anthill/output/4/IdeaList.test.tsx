import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import IdeaList from "./IdeaList";

describe("IdeaList", () => {
  it("renders without crashing", () => {
    render(<IdeaList />);
  });

  it("displays the heading", () => {
    render(<IdeaList />);
    expect(screen.getByText(/ideas wall/i)).toBeInTheDocument();
  });

  it("allows typing into the input field", () => {
    render(<IdeaList />);
    const input = screen.getByPlaceholderText(/add your idea/i);
    fireEvent.change(input, { target: { value: "New Idea" } });
    expect(input).toHaveValue("New Idea");
  });

  it("submits a new idea and displays it", () => {
    render(<IdeaList />);
    const input = screen.getByPlaceholderText(/add your idea/i);
    fireEvent.change(input, { target: { value: "New Idea" } });
    const button = screen.getByText(/submit/i);
    fireEvent.click(button);
    expect(screen.getByText(/new idea/i)).toBeInTheDocument();
  });

  it("increments the vote count when an idea is liked", () => {
    render(<IdeaList />);
    const input = screen.getByPlaceholderText(/add your idea/i);
    fireEvent.change(input, { target: { value: "New Idea" } });
    const button = screen.getByText(/submit/i);
    fireEvent.click(button);
    const likeButton = screen.getAllByText(/like/i)[0];
    fireEvent.click(likeButton);
    expect(screen.getByText(/votes: 1/i)).toBeInTheDocument();
  });
});