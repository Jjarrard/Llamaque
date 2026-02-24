import React, { useState } from "react";

export default function Component() {
  const [todos, setTodos] = useState([]);
  const [newTodo, setNewTodo] = useState("");
  const [editIndex, setEditIndex] = useState(null);
  const [isDarkMode, setIsDarkMode] = useState(false);

  const addTodo = () => {
    if (newTodo.trim()) {
      setTodos([...todos, { text: newTodo, completed: false }]);
      setNewTodo("");
    }
  };

  const editTodo = (index) => {
    setEditIndex(index);
    setNewTodo(todos[index].text);
  };

  const saveEdit = () => {
    if (editIndex !== null && newTodo.trim()) {
      const updatedTodos = [...todos];
      updatedTodos[editIndex] = { ...updatedTodos[editIndex], text: newTodo };
      setTodos(updatedTodos);
      setEditIndex(null);
      setNewTodo("");
    }
  };

  const toggleComplete = (index) => {
    const updatedTodos = [...todos];
    updatedTodos[index].completed = !updatedTodos[index].completed;
    setTodos(updatedTodos);
  };

  const removeTodo = (index) => {
    const updatedTodos = todos.filter((_, i) => i !== index);
    setTodos(updatedTodos);
  };

  const toggleDarkMode = () => {
    setIsDarkMode(!isDarkMode);
  };

  return (
    <div
      style={{
        fontFamily: "sans-serif",
        padding: "2rem",
        backgroundColor: isDarkMode ? "#121212" : "#fff",
        color: isDarkMode ? "#fff" : "#000",
        transition: "background-color 0.3s, color 0.3s",
      }}
    >
      <h1 style={{ outline: "2px solid #39ff14", padding: "0.5rem" }}>
        todo app
      </h1>
      <button
        onClick={toggleDarkMode}
        style={{
          backgroundColor: isDarkMode ? "#fff" : "#000",
          color: isDarkMode ? "#000" : "#fff",
          border: "none",
          padding: "0.5rem 1rem",
          cursor: "pointer",
          outline: "2px solid #39ff14",
        }}
      >
        {isDarkMode ? "Light Mode" : "Dark Mode"}
      </button>
      <input
        type="text"
        value={newTodo}
        onChange={(e) => setNewTodo(e.target.value)}
        style={{
          padding: "0.5rem",
          margin: "1rem 0",
          border: "2px solid #39ff14",
          outline: "none",
          transition: "border-color 0.3s",
          backgroundColor: isDarkMode ? "#1e1e1e" : "#f0f0f0",
          color: isDarkMode ? "#fff" : "#000",
        }}
      />
      <button
        onClick={editIndex !== null ? saveEdit : addTodo}
        style={{
          backgroundColor: "#39ff14",
          color: "#000",
          border: "none",
          padding: "0.5rem 1rem",
          cursor: "pointer",
          outline: "2px solid #39ff14",
        }}
      >
        {editIndex !== null ? "Save" : "Add"}
      </button>
      <ul
        style={{
          listStyleType: "none",
          padding: 0,
        }}
      >
        {todos.map((todo, index) => (
          <li
            key={index}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              margin: "0.5rem 0",
              backgroundColor: isDarkMode ? "#1e1e1e" : "#f0f0f0",
              padding: "0.5rem",
              borderRadius: "4px",
              outline: "2px solid #39ff14",
            }}
          >
            <div
              style={{
                textDecoration: todo.completed ? "line-through" : "none",
                color: isDarkMode ? "#fff" : "#000",
              }}
            >
              {todo.text}
            </div>
            <div>
              <button
                onClick={() => toggleComplete(index)}
                style={{
                  backgroundColor: "#39ff14",
                  color: "#000",
                  border: "none",
                  padding: "0.25rem 0.5rem",
                  cursor: "pointer",
                  outline: "2px solid #39ff14",
                  marginRight: "0.5rem",
                }}
              >
                {todo.completed ? "Undo" : "Complete"}
              </button>
              <button
                onClick={() => editTodo(index)}
                style={{
                  backgroundColor: "#39ff14",
                  color: "#000",
                  border: "none",
                  padding: "0.25rem 0.5rem",
                  cursor: "pointer",
                  outline: "2px solid #39ff14",
                  marginRight: "0.5rem",
                }}
              >
                Edit
              </button>
              <button
                onClick={() => removeTodo(index)}
                style={{
                  backgroundColor: "#39ff14",
                  color: "#000",
                  border: "none",
                  padding: "0.25rem 0.5rem",
                  cursor: "pointer",
                  outline: "2px solid #39ff14",
                }}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}