import React, { useState } from "react";

export default function Component() {
  const [username, setUsername] = useState("");
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [todos, setTodos] = useState([]);
  const [newTodo, setNewTodo] = useState("");

  const handleUsernameChange = (e) => {
    setUsername(e.target.value);
  };

  const completeOnboarding = () => {
    if (username.trim()) {
      setOnboardingComplete(true);
    }
  };

  const addTodo = () => {
    if (newTodo.trim()) {
      setTodos([...todos, { text: newTodo, completed: false }]);
      setNewTodo("");
    }
  };

  const toggleTodoCompletion = (index) => {
    const updatedTodos = todos.map((todo, i) =>
      i === index ? { ...todo, completed: !todo.completed } : todo
    );
    setTodos(updatedTodos);
  };

  const removeTodo = (index) => {
    const updatedTodos = todos.filter((_, i) => i !== index);
    setTodos(updatedTodos);
  };

  return (
    <div
      style={{
        fontFamily: "sans-serif",
        padding: "2rem",
        backgroundColor: "#121212",
        color: "#0ff",
        transition: "background-color 0.3s, color 0.3s",
        outline: onboardingComplete ? "4px solid #0ff" : "none",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <h1 style={{ borderBottom: "2px solid #0ff", paddingBottom: "1rem" }}>
        todo app
      </h1>
      {!onboardingComplete && (
        <div>
          <input
            type="text"
            value={username}
            onChange={handleUsernameChange}
            placeholder="Enter your name"
            style={{
              padding: "0.5rem",
              margin: "1rem 0",
              border: "2px solid #0ff",
              outline: "none",
              backgroundColor: "#1e1e1e",
              color: "#0ff",
              transition: "border-color 0.3s, background-color 0.3s",
            }}
          />
          <button
            onClick={completeOnboarding}
            style={{
              padding: "0.5rem 1rem",
              border: "2px solid #0ff",
              outline: "none",
              backgroundColor: "#1e1e1e",
              color: "#0ff",
              transition: "background-color 0.3s, border-color 0.3s",
            }}
          >
            Start
          </button>
        </div>
      )}
      {onboardingComplete && (
        <div style={{ marginTop: "2rem" }}>
          <p>Welcome, {username}! You're ready to manage your todos.</p>
          <input
            type="text"
            value={newTodo}
            onChange={(e) => setNewTodo(e.target.value)}
            placeholder="Add a new todo"
            style={{
              padding: "0.5rem",
              margin: "1rem 0",
              border: "2px solid #0ff",
              outline: "none",
              backgroundColor: "#1e1e1e",
              color: "#0ff",
              transition: "border-color 0.3s, background-color 0.3s",
            }}
          />
          <button
            onClick={addTodo}
            style={{
              padding: "0.5rem 1rem",
              border: "2px solid #0ff",
              outline: "none",
              backgroundColor: "#1e1e1e",
              color: "#0ff",
              transition: "background-color 0.3s, border-color 0.3s",
            }}
          >
            Add Todo
          </button>
          <ul style={{ listStyleType: "none", padding: 0 }}>
            {todos.map((todo, index) => (
              <li key={index} style={{ margin: "1rem 0" }}>
                <span
                  style={{
                    textDecoration: todo.completed ? "line-through" : "none",
                    marginRight: "1rem",
                  }}
                >
                  {todo.text}
                </span>
                <button
                  onClick={() => toggleTodoCompletion(index)}
                  style={{
                    padding: "0.5rem 1rem",
                    border: "2px solid #0ff",
                    outline: "none",
                    backgroundColor: "#1e1e1e",
                    color: "#0ff",
                    transition: "background-color 0.3s, border-color 0.3s",
                  }}
                >
                  {todo.completed ? "Undo" : "Complete"}
                </button>
                <button
                  onClick={() => removeTodo(index)}
                  style={{
                    padding: "0.5rem 1rem",
                    border: "2px solid #0ff",
                    outline: "none",
                    backgroundColor: "#1e1e1e",
                    color: "#0ff",
                    transition: "background-color 0.3s, border-color 0.3s",
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}