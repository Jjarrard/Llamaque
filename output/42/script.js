// script.js
const appState = { items: [], filter: "all", nextId: 1 };

function renderItems() {
  var list = document.getElementById("itemsList");
  if (!list) return;
  list.innerHTML = "";
  var items = appState.items;
  if (appState.filter === "active") items = items.filter(function(i) { return !i.done; });
  if (appState.filter === "completed") items = items.filter(function(i) { return i.done; });
  items.forEach(function(item) {
    var li = document.createElement("li");
    if (item.done) li.classList.add("completed");
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.done;
    cb.addEventListener("change", function() { toggleItem(item.id); });
    li.appendChild(cb);
    var span = document.createElement("span");
    span.textContent = item.text;
    if (item.date) span.textContent += " (" + item.date + ")";
    li.appendChild(span);
    list.appendChild(li);
  });
}

function handlePrimaryAction(event) {
  if (event) event.preventDefault();
  var input = document.getElementById("primaryInput");
  if (!input || !input.value.trim()) return;
  var newItem = { id: appState.nextId++, text: input.value.trim(), done: false };
  var dateInput = document.getElementById("dueDateInput");
  newItem.date = dateInput ? dateInput.value : "";
  appState.items.push(newItem);
  input.value = "";
  renderItems();
}

function toggleItem(id) {
  appState.items.forEach(function(item) {
    if (item.id === id) item.done = !item.done;
  });
  renderItems();
}

function setFilter(filterValue) {
  appState.filter = filterValue;
  var buttons = document.querySelectorAll("#filterControls button");
  buttons.forEach(function(btn) {
    btn.classList.toggle("active", btn.dataset.filter === filterValue);
  });
  renderItems();
}

function initApp() {
  var filterContainer = document.getElementById("filterControls");
  if (filterContainer) {
    ["all", "active", "completed"].forEach(function(f) {
      var btn = document.createElement("button");
      btn.textContent = f.charAt(0).toUpperCase() + f.slice(1);
      btn.dataset.filter = f;
      if (f === "all") btn.classList.add("active");
      btn.addEventListener("click", function() { setFilter(f); });
      filterContainer.appendChild(btn);
    });
  }
  renderItems();
}

const el_primaryForm_submit = document.getElementById("primaryForm");
if (el_primaryForm_submit) {
  el_primaryForm_submit.addEventListener("submit", handlePrimaryAction);
}

document.addEventListener("DOMContentLoaded", initApp);