import React, { useState } from "react";

export default function Component() {
  const [ideas, setIdeas] = useState([
    { id: 1, title: "Idea 1", description: "Description for Idea 1", votes: 0, comments: [] },
    { id: 2, title: "Idea 2", description: "Description for Idea 2", votes: 0, comments: [] },
    { id: 3, title: "Idea 3", description: "Description for Idea 3", votes: 0, comments: [] },
  ]);

  const [newIdeaTitle, setNewIdeaTitle] = useState("");
  const [newIdeaDescription, setNewIdeaDescription] = useState("");
  const [commentText, setCommentText] = useState("");
  const [selectedIdeaId, setSelectedIdeaId] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [expandedComments, setExpandedComments] = useState([]);

  const handleAddIdea = () => {
    if (newIdeaTitle.trim() && newIdeaDescription.trim()) {
      setIdeas([
        ...ideas,
        { id: Date.now(), title: newIdeaTitle, description: newIdeaDescription, votes: 0, comments: [] },
      ]);
      setNewIdeaTitle("");
      setNewIdeaDescription("");
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

  const handleToggleComments = (id) => {
    setExpandedComments((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  const sortedIdeas = [...ideas].sort((a, b) => b.votes - a.votes);

  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem", color: "#fff", backgroundColor: "#333" }}>
      <h1>Ideas Wall</h1>
      <button onClick={() => setIsModalOpen(true)} style={{ padding: "0.5rem 1rem", backgroundColor: "#444", color: "#fff", border: "none", cursor: "pointer", marginBottom: "2rem" }}>
        Create New Idea
      </button>
      {isModalOpen && (
        <div style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", backgroundColor: "rgba(0, 0, 0, 0.5)", display: "flex", justifyContent: "center", alignItems: "center" }}>
          <div style={{ backgroundColor: "#444", padding: "2rem", borderRadius: "8px", width: "300px", textAlign: "center" }}>
            <h2>Add New Idea</h2>
            <input
              type="text"
              value={newIdeaTitle}
              onChange={(e) => setNewIdeaTitle(e.target.value)}
              placeholder="Add a title for your idea"
              style={{ padding: "0.5rem", margin: "1rem 0" }}
            />
            <textarea
              value={newIdeaDescription}
              onChange={(e) => setNewIdeaDescription(e.target.value)}
              placeholder="Add a description for your idea"
              style={{ padding: "0.5rem", margin: "1rem 0", height: "6rem" }}
            />
            <button onClick={handleAddIdea} style={{ padding: "0.5rem 1rem", backgroundColor: "#555", color: "#fff", border: "none", cursor: "pointer", marginRight: "0.5rem" }}>
              Add Idea
            </button>
            <button onClick={() => setIsModalOpen(false)} style={{ padding: "0.5rem 1rem", backgroundColor: "#555", color: "#fff", border: "none", cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {sortedIdeas.slice(0, 3).map((idea) => (
          <div key={idea.id} style={{ border: "1px solid #555", padding: "1rem", borderRadius: "4px", backgroundColor: "#222", display: "flex", flexDirection: "column", alignItems: "center" }}>
            <h2>{idea.title}</h2>
            <p>{idea.description}</p>
            <p>Votes: {idea.votes}</p>
            <button onClick={() => handleVote(idea.id)} style={{ padding: "0.5rem 1rem", backgroundColor: "#444", color: "#fff", border: "none", cursor: "pointer" }}>
              Vote
            </button>
            <div style={{ marginTop: "1rem" }}>
              {expandedComments.includes(idea.id) && (
                <div>
                  {idea.comments.map((comment, index) => (
                    <p key={index}>{comment}</p>
                  ))}
                  <input
                    type="text"
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Add a comment"
                    style={{ padding: "0.5rem", margin: "1rem 0" }}
                  />
                  <button onClick={() => { setSelectedIdeaId(idea.id); handleAddComment(); }} style={{ padding: "0.5rem 1rem", backgroundColor: "#444", color: "#fff", border: "none", cursor: "pointer" }}>
                    Add Comment
                  </button>
                </div>
              )}
              <button onClick={() => handleToggleComments(idea.id)} style={{ padding: "0.5rem 1rem", backgroundColor: "#444", color: "#fff", border: "none", cursor: "pointer" }}>
                {expandedComments.includes(idea.id) ? "Hide Comments" : "Show Comments"}
              </button>
            </div>
          </div>
        ))}
        <h2>Other Ideas</h2>
        {sortedIdeas.slice(3).map((idea) => (
          <div key={idea.id} style={{ border: "1px solid #555", padding: "1rem", borderRadius: "4px", backgroundColor: "#222", display: "flex", flexDirection: "column", alignItems: "center" }}>
            <h2>{idea.title}</h2>
            <p>{idea.description}</p>
            <p>Votes: {idea.votes}</p>
            <button onClick={() => handleVote(idea.id)} style={{ padding: "0.5rem 1rem", backgroundColor: "#444", color: "#fff", border: "none", cursor: "pointer" }}>
              Vote
            </button>
            <div style={{ marginTop: "1rem" }}>
              {expandedComments.includes(idea.id) && (
                <div>
                  {idea.comments.map((comment, index) => (
                    <p key={index}>{comment}</p>
                  ))}
                  <input
                    type="text"
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Add a comment"
                    style={{ padding: "0.5rem", margin: "1rem 0" }}
                  />
                  <button onClick={() => { setSelectedIdeaId(idea.id); handleAddComment(); }} style={{ padding: "0.5rem 1rem", backgroundColor: "#444", color: "#fff", border: "none", cursor: "pointer" }}>
                    Add Comment
                  </button>
                </div>
              )}
              <button onClick={() => handleToggleComments(idea.id)} style={{ padding: "0.5rem 1rem", backgroundColor: "#444", color: "#fff", border: "none", cursor: "pointer" }}>
                {expandedComments.includes(idea.id) ? "Hide Comments" : "Show Comments"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}