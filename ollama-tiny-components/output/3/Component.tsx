import React, { useState } from "react";

export default function Component() {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [votes, setVotes] = useState(options.map(() => 0));
  const [hasVoted, setHasVoted] = useState(false);
  const [pollSubmitted, setPollSubmitted] = useState(false);
  const [userLoggedIn, setUserLoggedIn] = useState(null);

  const handleOptionChange = (index, event) => {
    const newOptions = [...options];
    newOptions[index] = event.target.value;
    setOptions(newOptions);
  };

  const handleVote = (index) => {
    if (!hasVoted) {
      const newVotes = [...votes];
      newVotes[index]++;
      setVotes(newVotes);
      setHasVoted(true);
    }
  };

  const handleSubmitPoll = () => {
    if (question.trim() === "" || options.some(option => option.trim() === "")) {
      alert("Please fill in all fields.");
      return;
    }
    localStorage.setItem("pollQuestion", question);
    localStorage.setItem("pollOptions", JSON.stringify(options));
    localStorage.setItem("pollVotes", JSON.stringify(votes));
    setPollSubmitted(true);
  };

  const handleLogin = (username) => {
    setUserLoggedIn(username);
  };

  const handleEditPoll = () => {
    if (!userLoggedIn) return;
    // Implement edit logic here
    alert("Editing poll...");
  };

  const handleDeletePoll = () => {
    if (!userLoggedIn) return;
    localStorage.removeItem("pollQuestion");
    localStorage.removeItem("pollOptions");
    localStorage.removeItem("pollVotes");
    setPollSubmitted(false);
    alert("Poll deleted.");
  };

  if (pollSubmitted) {
    return (
      <div style={{ fontFamily: "sans-serif", padding: "2rem" }}>
        <h1>Poll Submitted</h1>
        <p>Thank you for creating your poll!</p>
        <button
          onClick={handleEditPoll}
          style={{
            padding: "0.5rem 1rem",
            fontSize: "1rem",
            backgroundColor: "#007bff",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          Edit Poll
        </button>
        <button
          onClick={handleDeletePoll}
          style={{
            padding: "0.5rem 1rem",
            fontSize: "1rem",
            backgroundColor: "#dc3545",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            marginLeft: "1rem",
          }}
        >
          Delete Poll
        </button>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <h1>Poll / Voting App</h1>
      {!userLoggedIn && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: "1rem",
          }}
        >
          <input
            type="text"
            placeholder="Username"
            style={{
              padding: "0.5rem 1rem",
              fontSize: "1rem",
              border: "1px solid #ccc",
              borderRadius: "4px",
              marginRight: "1rem",
            }}
          />
          <button
            onClick={() => handleLogin("user")}
            style={{
              padding: "0.5rem 1rem",
              fontSize: "1rem",
              backgroundColor: "#28a745",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Login
          </button>
        </div>
      )}
      <input
        type="text"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Enter your question"
        style={{
          width: "100%",
          padding: "0.5rem 1rem",
          fontSize: "1rem",
          border: "1px solid #ccc",
          borderRadius: "4px",
          marginBottom: "1rem",
        }}
      />
      {options.map((option, index) => (
        <div
          key={index}
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: "0.5rem",
          }}
        >
          <input
            type="text"
            value={option}
            onChange={(e) => handleOptionChange(index, e)}
            placeholder={`Option ${index + 1}`}
            style={{
              padding: "0.5rem 1rem",
              fontSize: "1rem",
              border: "1px solid #ccc",
              borderRadius: "4px",
              marginRight: "1rem",
            }}
          />
          <button
            onClick={() => handleVote(index)}
            disabled={hasVoted}
            style={{
              padding: "0.5rem 1rem",
              fontSize: "1rem",
              backgroundColor: hasVoted ? "#ccc" : "#28a745",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: hasVoted ? "not-allowed" : "pointer",
            }}
          >
            Vote
          </button>
        </div>
      ))}
      <button
        onClick={() => setOptions([...options, ""])}
        style={{
          padding: "0.5rem 1rem",
          fontSize: "1rem",
          backgroundColor: "#007bff",
          color: "#fff",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer",
          marginBottom: "1rem",
        }}
      >
        Add Option
      </button>
      <button
        onClick={handleSubmitPoll}
        style={{
          padding: "0.5rem 1rem",
          fontSize: "1rem",
          backgroundColor: "#28a745",
          color: "#fff",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer",
        }}
      >
        Submit Poll
      </button>
    </div>
  );
}