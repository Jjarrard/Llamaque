  // script.js

  const appState = {}; // Shared state model

  function initApp() {
    const root = document.getElementById("app");
    if (!root) return;

    // Add new task functionality
    const el_primaryForm = document.getElementById("primaryForm");
    const el_primaryInput = document.getElementById("primaryInput");
    const el_primaryActionButton = document.getElementById("primaryActionButton");

    function handlePrimaryAction(event) {
      if (event) event.preventDefault();

      // Get the input value and create a new task object
      const title = el_primaryInput.value;
      const task = { title, completed: false };

      // Add the task to the list of tasks in local storage
      appState.tasks.push(task);

      // Render the task as an HTML element on the page
      const li = document.createElement("li");
      li.classList.add("task");
      li.innerHTML = `
        <input type="checkbox" ${task.completed ? "checked" : ""}>
        <label>${task.title}</label>
        <button class="delete">Delete</button>
      `;
      el_itemsList.appendChild(li);

      // Update the UI when a task is added
      updateUI();
    }

    if (el_primaryForm && el_primaryInput && el_primaryActionButton) {
      el_primaryForm.addEventListener("submit", handlePrimaryAction);
    }

    // Delete task functionality
    const el_itemsList = document.getElementById("itemsList");

    function handleDeleteTask(event) {
      if (event) event.preventDefault();

      // Get the index of the task to delete
      const li = event.target.parentNode;
      const index = [...el_itemsList.children].indexOf(li);

      // Remove the task from the list of tasks in local storage
      appState.tasks.splice(index, 1);

      // Update the UI when a task is deleted
      updateUI();
    }

    if (el_itemsList) {
      el_itemsList.addEventListener("click", handleDeleteTask);
    }

    // Toggle completion status of a task functionality
    function handleToggleCompletion(event) {
      if (event) event.preventDefault();

      // Get the index of the task to toggle
      const li = event.target.parentNode;
      const index = [...el_itemsList.children].indexOf(li);

      // Toggle the completion status of the task in local storage
      appState.tasks[index].completed = !appState.tasks[index].completed;

      // Update the UI when a task is completed or uncompleted
      updateUI();
    }

    if (el_itemsList) {
      el_itemsList.addEventListener("click", handleToggleCompletion);
    }

    // Update the UI when a task is added, deleted, or completed
    function updateUI() {
      const tasks = appState.tasks;
      const html = tasks.map((task) => `
        <li class="task">
          <input type="checkbox" ${task.completed ? "checked" : ""}>
          <label>${task.title}</label>
          <button class="delete">Delete</button>
        </li>
      `).join("");
      el_itemsList.innerHTML = html;
    }
  }

  // Initialize the app when the DOM is ready
  document.addEventListener("DOMContentLoaded", initApp);

  // Update the UI when the window is resized
  window.addEventListener("resize", updateUI);

  const el_primaryActionButton_click = document.getElementById("primaryActionButton");
  if (el_primaryActionButton_click) {
    el_primaryActionButton_click.addEventListener("click", handlePrimaryAction);
  }

Write the COMPLETE script.js file. It must include:
1. Implement the functionality to add new tasks
2. Implement the functionality to delete a task in script.js"
3. Add a button to toggle the completion status of a task

CRITICAL JavaScript rules:
- Declare each variable/function exactly once
- Use one shared state model (do not reinitialize state in multiple places)
- Do not duplicate event listeners for the same element+event pair