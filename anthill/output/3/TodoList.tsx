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
    if (newTodo.trim() && editIndex !== null) {
      const updatedTodos = [...todos];
      updatedTodos[editIndex] = { ...updatedTodos[editIndex], text: newTodo };
      setTodos(updatedTodos);
      setNewTodo("");
      setEditIndex(null);
    }
  };

  const toggleComplete = (index) => {
    const updatedTodos = todos.map((todo, i) =>
      i === index ? { ...todo, completed: !todo.completed } : todo
    );
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
      <h1 style={{ outline: "2px solid #66ffcc", padding: "0.5rem" }}>
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
          outline: "2px solid #66ffcc",
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
          border: "2px solid #66ffcc",
          outline: "none",
          transition: "border-color 0.3s",
          borderColor: newTodo ? "#66ffcc" : "#ccc",
        }}
      />
      {editIndex !== null ? (
        <button
          onClick={saveEdit}
          style={{
            backgroundColor: "#66ffcc",
            color: "#000",
            border: "none",
            padding: "0.5rem 1rem",
            cursor: "pointer",
            outline: "2px solid #66ffcc",
          }}
        >
          Save
        </button>
      ) : (
        <button
          onClick={addTodo}
          style={{
            backgroundColor: "#66ffcc",
            color: "#000",
            border: "none",
            padding: "0.5rem 1rem",
            cursor: "pointer",
            outline: "2px solid #66ffcc",
          }}
        >
          Add
        </button>
      )}
      <ul style={{ listStyleType: "none", padding: 0 }}>
        {todos.map((todo, index) => (
          <li
            key={index}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              margin: "0.5rem 0",
              outline: todo.completed ? "2px solid #66ffcc" : "none",
            }}
          >
            <span
              style={{
                textDecoration: todo.completed ? "line-through" : "none",
                color: todo.completed ? "#888" : "#000",
              }}
            >
              {todo.text}
            </span>
            <div>
              <button
                onClick={() => editTodo(index)}
                style={{
                  backgroundColor: "#66ffcc",
                  color: "#000",
                  border: "none",
                  padding: "0.3rem 0.75rem",
                  cursor: "pointer",
                  outline: "2px solid #66ffcc",
                  marginRight: "0.5rem",
                }}
              >
                Edit
              </button>
              <button
                onClick={() => toggleComplete(index)}
                style={{
                  backgroundColor: "#66ffcc",
                  color: "#000",
                  border: "none",
                  padding: "0.3rem 0.75rem",
                  cursor: "pointer",
                  outline: "2px solid #66ffcc",
                  marginRight: "0.5rem",
                }}
              >
                {todo.completed ? "Undo" : "Complete"}
              </button>
              <button
                onClick={() => removeTodo(index)}
                style={{
                  backgroundColor: "#ff6666",
                  color: "#000",
                  border: "none",
                  padding: "0.3rem 0.75rem",
                  cursor: "pointer",
                  outline: "2px solid #ff6666",
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