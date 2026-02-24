import React, { useState } from "react";

export default function Component() {
  const [ideas, setIdeas] = useState([
    { id: 1, text: "Idea 1", votes: 0, comments: [] },
    { id: 2, text: "Idea 2", votes: 0, comments: [] },
    { id: 3, text: "Idea 3", votes: 0, comments: [] },
  ]);
  const [newIdeaText, setNewIdeaText] = useState("");
  const [commentText, setCommentText] = useState("");
  const [selectedIdeaId, setSelectedIdeaId] = useState(null);

  const handleAddIdea = () => {
    if (newIdeaText.trim()) {
      setIdeas([
        ...ideas,
        { id: Date.now(), text: newIdeaText, votes: 0, comments: [] },
      ]);
      setNewIdeaText("");
    }
  };

  const handleVote = (id) => {
    setIdeas(
      ideas.map((idea) =>
        idea.id === id ? { ...idea, votes: idea.votes + 1 } : idea
      )
    );
  };

  const handleCommentChange = (e) => {
    setCommentText(e.target.value);
  };

  const handleAddComment = () => {
    if (commentText.trim() && selectedIdeaId !== null) {
      setIdeas(
        ideas.map((idea) =>
          idea.id === selectedIdeaId
            ? { ...idea, comments: [...idea.comments, commentText] }
            : idea
        )
      );
      setCommentText("");
    }
  };

  const topThreeIdeas = ideas.sort((a, b) => b.votes - a.votes).slice(0, 3);
  const remainingIdeas = ideas.sort((a, b) => b.votes - a.votes).slice(3);

  return (
    <div
      style={{
        fontFamily: "sans-serif",
        padding: "2rem",
        backgroundColor: "#121212",
        color: "#ffffff",
      }}
    >
      <h1>Ideas Wall</h1>
      <input
        type="text"
        value={newIdeaText}
        onChange={(e) => setNewIdeaText(e.target.value)}
        placeholder="Add a new idea"
        style={{
          padding: "0.5rem",
          margin: "1rem 0",
          border: "none",
          borderRadius: "4px",
          backgroundColor: "#222222",
          color: "#ffffff",
        }}
      />
      <button
        onClick={handleAddIdea}
        style={{
          padding: "0.5rem 1rem",
          border: "none",
          borderRadius: "4px",
          backgroundColor: "#333333",
          color: "#ffffff",
          cursor: "pointer",
        }}
      >
        Add Idea
      </button>
      <h2>Top Ideas</h2>
      {topThreeIdeas.map((idea) => (
        <div key={idea.id} style={{ marginBottom: "1rem" }}>
          <p>{idea.text}</p>
          <button
            onClick={() => handleVote(idea.id)}
            style={{
              padding: "0.3rem 0.6rem",
              border: "none",
              borderRadius: "4px",
              backgroundColor: "#444444",
              color: "#ffffff",
              cursor: "pointer",
            }}
          >
            Vote
          </button>
          <div style={{ marginTop: "0.5rem" }}>
            {idea.comments.map((comment, index) => (
              <p key={index} style={{ margin: 0 }}>{comment}</p>
            ))}
          </div>
        </div>
      ))}
      <h2>Other Ideas</h2>
      {remainingIdeas.map((idea) => (
        <div key={idea.id} style={{ marginBottom: "1rem" }}>
          <p>{idea.text}</p>
          <button
            onClick={() => handleVote(idea.id)}
            style={{
              padding: "0.3rem 0.6rem",
              border: "none",
              borderRadius: "4px",
              backgroundColor: "#444444",
              color: "#ffffff",
              cursor: "pointer",
            }}
          >
            Vote
          </button>
          <div style={{ marginTop: "0.5rem" }}>
            {idea.comments.map((comment, index) => (
              <p key={index} style={{ margin: 0 }}>{comment}</p>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}