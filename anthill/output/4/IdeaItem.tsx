import React, { useState } from "react";

export default function Component() {
  const [ideas, setIdeas] = useState([
    { id: 1, text: "Idea 1", votes: 0, comments: [] },
    { id: 2, text: "Idea 2", votes: 0, comments: [] },
    { id: 3, text: "Idea 3", votes: 0, comments: [] },
  ]);
  const [newComment, setNewComment] = useState("");
  const [selectedIdeaId, setSelectedIdeaId] = useState(null);

  const handleVote = (id) => {
    setIdeas((prevIdeas) =>
      prevIdeas.map((idea) =>
        idea.id === id ? { ...idea, votes: idea.votes + 1 } : idea
      )
    );
  };

  const handleCommentChange = (e) => {
    setNewComment(e.target.value);
  };

  const handleAddComment = () => {
    if (newComment.trim() !== "") {
      setIdeas((prevIdeas) =>
        prevIdeas.map((idea) =>
          idea.id === selectedIdeaId
            ? { ...idea, comments: [...idea.comments, newComment] }
            : idea
        )
      );
      setNewComment("");
    }
  };

  const sortedIdeas = ideas.sort((a, b) => b.votes - a.votes);

  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem", color: "#fff", backgroundColor: "#333" }}>
      <h1>Ideas Wall</h1>
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {sortedIdeas.slice(0, 3).map((idea) => (
          <IdeaItem
            key={idea.id}
            idea={idea}
            handleVote={handleVote}
            newComment={newComment}
            setNewComment={setNewComment}
            selectedIdeaId={selectedIdeaId}
            setSelectedIdeaId={setSelectedIdeaId}
            handleAddComment={handleAddComment}
          />
        ))}
        {sortedIdeas.slice(3).map((idea) => (
          <IdeaItem
            key={idea.id}
            idea={idea}
            handleVote={handleVote}
            newComment={newComment}
            setNewComment={setNewComment}
            selectedIdeaId={selectedIdeaId}
            setSelectedIdeaId={setSelectedIdeaId}
            handleAddComment={handleAddComment}
          />
        ))}
      </div>
    </div>
  );
}

const IdeaItem = ({ idea, handleVote, newComment, setNewComment, selectedIdeaId, setSelectedIdeaId, handleAddComment }) => {
  return (
    <div
      style={{
        border: "1px solid #555",
        padding: "1rem",
        borderRadius: "8px",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
      }}
    >
      <h2>{idea.text}</h2>
      <p>Votes: {idea.votes}</p>
      <button
        onClick={() => handleVote(idea.id)}
        style={{
          padding: "0.5rem 1rem",
          backgroundColor: "#444",
          color: "#fff",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer",
        }}
      >
        Upvote
      </button>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <input
          type="text"
          value={newComment}
          onChange={handleCommentChange}
          placeholder="Add a comment..."
          style={{
            padding: "0.5rem",
            border: "1px solid #555",
            borderRadius: "4px",
            flex: 1,
          }}
        />
        <button
          onClick={handleAddComment}
          disabled={!newComment.trim()}
          style={{
            padding: "0.5rem 1rem",
            backgroundColor: "#444",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          Comment
        </button>
      </div>
      <ul style={{ listStyleType: "none", padding: 0, margin: 0 }}>
        {idea.comments.map((comment, index) => (
          <li key={index} style={{ marginBottom: "0.5rem" }}>
            {comment}
          </li>
        ))}
      </ul>
    </div>
  );
}