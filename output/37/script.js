// script.js
const appState = { items: [], filter: "all", nextId: 1 };

function renderItems() {
  var list = document.getElementById("itemsList");
  if (!list) return;
  list.innerHTML = "";
  var items = appState.items;
  items.forEach(function(item) {
    var li = document.createElement("li");
    var span = document.createElement("span");
    span.textContent = item.text;
    if (item.date) span.textContent += " (" + item.date + ")";
    li.appendChild(span);
    var delBtn = document.createElement("button");
    delBtn.textContent = "\u00D7";
    delBtn.className = "delete-btn";
    delBtn.addEventListener("click", function() { removeItem(item.id); });
    li.appendChild(delBtn);
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

function removeItem(id) {
  appState.items = appState.items.filter(function(item) { return item.id !== id; });
  renderItems();
}

function initApp() {
  renderItems();
}

const el_primaryForm_submit = document.getElementById("primaryForm");
if (el_primaryForm_submit) {
  el_primaryForm_submit.addEventListener("submit", handlePrimaryAction);
}

document.addEventListener("DOMContentLoaded", initApp);