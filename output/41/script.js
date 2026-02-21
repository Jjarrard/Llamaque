// script.js
const appState = {
  focusDuration: 25,
  breakDuration: 5,
  timer: null,
  isFocus: true,
  remainingTime: 0,
};

function handlePrimaryAction(event) {
  if (event) event.preventDefault();
  const primaryInput = document.getElementById("primaryInput").value;
  const focusDuration = parseInt(document.getElementById("focusDuration").value);
  const breakDuration = parseInt(document.getElementById("breakDuration").value);

  appState.focusDuration = focusDuration;
  appState.breakDuration = breakDuration;
  appState.remainingTime = focusDuration * 60;
  appState.isFocus = true;

  startTimer();
}

function initApp() {
  var root = document.getElementById("app");
  if (!root) return;
}

const el_primaryForm_submit = document.getElementById("primaryForm");
if (el_primaryForm_submit) {
  el_primaryForm_submit.addEventListener("submit", handlePrimaryAction);
}

function startTimer() {
  appState.timer = setInterval(() => {
    appState.remainingTime--;
    updateDisplay();

    if (appState.remainingTime <= 0) {
      clearInterval(appState.timer);
      appState.isFocus = !appState.isFocus;
      appState.remainingTime = appState.isFocus ? appState.focusDuration * 60 : appState.breakDuration * 60;
      startTimer();
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(appState.timer);
}

function resetTimer() {
  stopTimer();
  appState.remainingTime = appState.isFocus ? appState.focusDuration * 60 : appState.breakDuration * 60;
  updateDisplay();
}

function updateDisplay() {
  const minutes = Math.floor(appState.remainingTime / 60);
  const seconds = appState.remainingTime % 60;
  const display = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  document.getElementById("appTitle").textContent = `pomodoro app - ${display}`;
}

document.addEventListener("DOMContentLoaded", initApp);