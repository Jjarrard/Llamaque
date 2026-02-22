// script.js
const appState = { items: [], filter: "all", nextId: 1 };

function renderItems() {
  var backlogList = document.getElementById("backlogList");
  var inProgressList = document.getElementById("inProgressList");
  var qaList = document.getElementById("qaList");
  var doneList = document.getElementById("doneList");

  if (!backlogList || !inProgressList || !qaList || !doneList) return;

  backlogList.innerHTML = "";
  inProgressList.innerHTML = "";
  qaList.innerHTML = "";
  doneList.innerHTML = "";

  var items = appState.items;
  items.forEach(function(item) {
    var li = document.createElement("li");
    li.id = item.id; // Add unique ID to each list item
    var span = document.createElement("span");
    span.textContent = item.text;
    li.appendChild(span);

    var editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.className = "edit-btn";
    editBtn.addEventListener("click", function() { editItem(item.id); });
    li.appendChild(editBtn);

    var delBtn = document.createElement("button");
    delBtn.textContent = "\u00D7";
    delBtn.className = "delete-btn";
    delBtn.addEventListener("click", function() { removeItem(item.id); });
    li.appendChild(delBtn);

    switch (item.status) {
      case "inProgress":
        inProgressList.appendChild(li);
        break;
      case "qa":
        qaList.appendChild(li);
        break;
      case "done":
        doneList.appendChild(li);
        break;
      default:
        backlogList.appendChild(li);
        break;
    }

    // Add drag event listeners to list items
    li.draggable = true;
    li.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', li.id);
    });
  });
}

function handlePrimaryAction(event) {
  if (event) event.preventDefault();
  var input = document.getElementById("primaryInput");
  if (!input || !input.value.trim()) return;
  var newItem = { id: appState.nextId++, text: input.value.trim(), status: "backlog" };
  appState.items.push(newItem);
  input.value = "";
  renderItems();
}

function removeItem(id) {
  appState.items = appState.items.filter(function(item) { return item.id !== id; });
  renderItems();
}

function editItem(id) {
  var input = document.getElementById("primaryInput");
  if (!input) return;
  var item = appState.items.find(function(item) { return item.id === id; });
  if (item) {
    input.value = item.text;
    removeItem(id);
  }
}

function moveItem(id, status) {
  var item = appState.items.find(function(item) { return item.id === id; });
  if (item) {
    item.status = status;
    renderItems();
  }
}

function initApp() {
  renderItems();

  // Add event listeners for drag and drop
  document.querySelectorAll("#kanbanBoard section").forEach(section => {
    section.addEventListener('dragover', e => {
      e.preventDefault();
    });

    section.addEventListener('drop', e => {
      const id = e.dataTransfer.getData('text/plain');
      let status;
      switch (section.id) {
        case "inProgress":
          status = "inProgress";
          break;
        case "qa":
          status = "qa";
          break;
        case "done":
          status = "done";
          break;
        default:
          status = "backlog";
          break;
      }
      moveItem(parseInt(id), status);
    });
  });
}

const el_primaryForm_submit = document.getElementById("primaryForm");
if (el_primaryForm_submit) {
  el_primaryForm_submit.addEventListener("submit", handlePrimaryAction);
}

document.addEventListener("DOMContentLoaded", initApp);