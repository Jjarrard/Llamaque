// script.js
const appState = { count: 0 };
function handlePrimaryAction(event) {
  if (event) event.preventDefault();
}
function initApp() {
  var root = document.getElementById("app");
  if (!root) return;
}
const el_primaryForm_submit = document.getElementById("primaryForm");
if (el_primaryForm_submit) {
  el_primaryForm_submit.addEventListener("submit", handlePrimaryAction);
}
document.addEventListener("DOMContentLoaded", initApp);
function startTimer() {
  // Start the timer
  const timerElement = document.createElement('div');
  timerElement.id = 'timer';
  timerElement.textContent = '00:00';
  document.body.appendChild(timerElement);
  // Start counting time
  let startTime = Date.now();
  const interval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    timerElement.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }, 1000);
}
function startButtonHandler(event) {
  event.preventDefault();
  startTimer();
}
const startButton = document.getElementById('startButton');
if (startButton) {
  startButton.addEventListener('click', startButtonHandler);
}