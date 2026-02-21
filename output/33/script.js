  // Get references to the form and task list elements
  const taskForm = document.getElementById("task-form");
  const taskList = document.getElementById("task-list");

  // Add a new task to the list
  function addTask(task) {
    // Create a new list item for the task
    const li = document.createElement("li");

    // Create an input element for the task name
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = false;
    input.addEventListener("change", () => {
      if (input.checked) {
        li.classList.add("completed");
      } else {
        li.classList.remove("completed");
      }
    });

    // Create a button element for the task name
    const button = document.createElement("button");
    button.textContent = task;
    button.addEventListener("click", () => {
      taskList.removeChild(li);
    });

    // Add the input and button elements to the list item
    li.appendChild(input);
    li.appendChild(document.createTextNode(" "));
    li.appendChild(button);

    // Add the list item to the task list
    taskList.appendChild(li);
  }

  // Get the form elements
  const taskInput = document.getElementById("task-input");
  const addButton = document.querySelector("#task-form button[type='submit']");

  // Add a new task to the list when the form is submitted
  function handleFormSubmit(event) {
    event.preventDefault();
    addTask(taskInput.value);
    taskInput.value = "";
  }

  // Set up the event listener for the form submission
  taskForm.addEventListener("submit", handleFormSubmit);

  // Add a default task to the list
  addTask("Default Task");

  // Remove completed tasks from the list
  function removeCompletedTasks() {
    const completedTasks = document.querySelectorAll(".completed");
    completedTasks.forEach((task) => {
      taskList.removeChild(task);
    });
  }

  // Set up the event listener for the "X" button
  taskList.addEventListener("click", removeCompletedTasks);

  // Remove completed tasks when the page loads
  window.onload = () => {
    removeCompletedTasks();
  };
<<END