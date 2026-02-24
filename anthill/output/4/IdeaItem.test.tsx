import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import IdeaItem from "./IdeaItem";

const idea = {
  id: 1,
  title: "Test Idea",
  votes: 0,
  comments: [],
};

describe("IdeaItem", () => {
  it("renders without crashing", () => {
    render(<IdeaItem idea={idea} />);
  });

  it("displays the idea title", () => {
    render(<IdeaItem idea={idea} />);
    expect(screen.getByText(idea.title)).toBeInTheDocument();
  });

  it("allows typing into the comment input", () => {
    render(<IdeaItem idea={idea} />);
    const input = screen.getByPlaceholderText(/add a comment/i);
    fireEvent.change(input, { target: { value: "New Comment" } });
    expect(input).toHaveValue("New Comment");
  });

  it("increments vote count when upvote button is clicked", () => {
    render(<IdeaItem idea={idea} />);
    const upvoteButton = screen.getByText(/upvote/i);
    fireEvent.click(upvoteButton);
    expect(screen.getByText(/1 vote/i)).toBeInTheDocument();
  });
});