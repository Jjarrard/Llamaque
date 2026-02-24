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
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleAddIdea = () => {
    if (newIdeaText.trim()) {
      setIdeas([
        ...ideas,
        { id: Date.now(), text: newIdeaText, votes: 0, comments: [] },
      ]);
      setNewIdeaText("");
      setIsModalOpen(false);
    }
  };

  const handleVote = (id) => {
    setIdeas(
      ideas.map((idea) =>
        idea.id === id ? { ...idea, votes: idea.votes + 1 } : idea
      )
    );
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

  const sortedIdeas = [...ideas].sort((a, b) => b.votes - a.votes);

  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem", color: "#fff", backgroundColor: "#333" }}>
      <h1>Ideas Wall</h1>
      <button onClick={() => setIsModalOpen(true)} style={{ padding: "0.5rem", backgroundColor: "#444", color: "#fff", border: "none", cursor: "pointer", marginBottom: "2rem" }}>
        Create New Idea
      </button>
      {isModalOpen && (
        <div style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", backgroundColor: "rgba(0, 0, 0, 0.5)", display: "flex", justifyContent: "center", alignItems: "center" }}>
          <div style={{ backgroundColor: "#444", padding: "2rem", borderRadius: "8px", width: "300px", textAlign: "center" }}>
            <h2>Add New Idea</h2>
            <input
              type="text"
              value={newIdeaText}
              onChange={(e) => setNewIdeaText(e.target.value)}
              placeholder="Add a new idea"
              style={{ padding: "0.5rem", margin: "1rem 0" }}
            />
            <button onClick={handleAddIdea} style={{ padding: "0.5rem", backgroundColor: "#555", color: "#fff", border: "none", cursor: "pointer", marginRight: "0.5rem" }}>
              Add Idea
            </button>
            <button onClick={() => setIsModalOpen(false)} style={{ padding: "0.5rem", backgroundColor: "#555", color: "#fff", border: "none", cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {sortedIdeas.slice(0, 3).map((idea) => (
          <div key={idea.id} style={{ border: "1px solid #555", padding: "1rem", borderRadius: "4px", backgroundColor: "#222" }}>
            <h2>{idea.text}</h2>
            <p>Votes: {idea.votes}</p>
            <button onClick={() => handleVote(idea.id)} style={{ padding: "0.5rem", backgroundColor: "#444", color: "#fff", border: "none", cursor: "pointer" }}>
              Vote
            </button>
            <div style={{ marginTop: "1rem" }}>
              {idea.comments.map((comment, index) => (
                <p key={index}>{comment}</p>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginTop: "2rem" }}>
        {sortedIdeas.slice(3).map((idea) => (
          <div key={idea.id} style={{ border: "1px solid #555", padding: "1rem", borderRadius: "4px" }}>
            <h2>{idea.text}</h2>
            <p>Votes: {idea.votes}</p>
            <button onClick={() => handleVote(idea.id)} style={{ padding: "0.5rem", backgroundColor: "#444", color: "#fff", border: "none", cursor: "pointer" }}>
              Vote
            </button>
            <div style={{ marginTop: "1rem" }}>
              {idea.comments.map((comment, index) => (
                <p key={index}>{comment}</p>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}