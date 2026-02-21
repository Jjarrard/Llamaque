  // Get references to DOM elements
  const todoInput = document.getElementById("todo-input");
  const todoButton = document.getElementById("todo-button");
  const todoList = document.querySelector(".todo-list");

  // Add todo functionality
  function addTodo() {
    // Get the new todo text from the input value
    const todoText = todoInput.value;

    // Create a new li element for the todo and append it to the list
    const newTodo = document.createElement("li");
    newTodo.innerText = todoText;
    todoList.appendChild(newTodo);

    // Clear the input value
    todoInput.value = "";
  }

  // Remove completed todos functionality
  function removeCompletedTodos() {
    // Get all li elements in the todo list
    const todos = document.querySelectorAll(".todo-list li");

    // Loop through the li elements and remove those that have a completed class
    todos.forEach((todo) => {
      if (todo.classList.contains("completed")) {
        todo.remove();
      }
    });
  }

  // Complete todo functionality
  function completeTodo(todo) {
    // Get the text content of the clicked todo element
    const todoText = todo.innerText;

    // Create a new li element for the completed todo and append it to the list
    const completedTodo = document.createElement("li");
    completedTodo.innerText = todoText;
    completedTodo.classList.add("completed");
    todoList.appendChild(completedTodo);

    // Remove the clicked todo element from the list
    todo.remove();
  }

  // Update UI functionality
  function updateUI() {
    // Get all li elements in the todo list
    const todos = document.querySelectorAll(".todo-list li");

    // Loop through the li elements and add a completed class to those that have a completed class
    todos.forEach((todo) => {
      if (todo.classList.contains("completed")) {
        todo.classList.add("line-through");
      } else {
        todo.classList.remove("line-through");
      }
    });
  }

  // Event listeners
  todoButton.addEventListener("click", addTodo);
  todoList.addEventListener("click", removeCompletedTodos);
  todoList.addEventListener("click", completeTodo);
  todoList.addEventListener("click", updateUI);

  // DOMContentLoaded event listener
  document.addEventListener("DOMContentLoaded", function () {
    console.log("DOM is loaded");
  });
<<END