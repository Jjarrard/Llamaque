// script.js
const appState = { items: [], filter: "all", nextId: 1 };
function renderItems() {
  const list = document.getElementById("itemsList");
  if (!list) return;
  list.innerHTML = "";
  const items = appState.items;
  items.forEach(item => {
    const li = document.createElement("li");
    if (item.done) li.classList.add("completed");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.done;
    cb.addEventListener("change", () => toggleItem(item.id));
    li.appendChild(cb);
    const span = document.createElement("span");
    span.textContent = item.text;
    li.appendChild(span);
    list.appendChild(li);
  });
}
function handlePrimaryAction(event) {
  event.preventDefault();
  const input = document.getElementById("primaryInput");
  if (!input || !input.value.trim()) return;
  const newItem = { id: appState.nextId++, text: input.value.trim(), done: false };
  appState.items.push(newItem);
  input.value = "";
  renderItems();
}
function toggleItem(id) {
  const item = appState.items.find(item => item.id === id);
  if (item) item.done = !item.done;
  renderItems();
}
function initApp() {
  renderItems();
}
const primaryForm = document.getElementById("primaryForm");
if (primaryForm) {
  primaryForm.addEventListener("submit", handlePrimaryAction);
}
document.addEventListener("DOMContentLoaded", initApp);