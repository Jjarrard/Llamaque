// script.js
const appState = { count: 0 };
let intervalId;
let isRunning = false;

function startTimer() {
  if (!isRunning) {
    isRunning = true;
    intervalId = setInterval(() => {
      const timeDisplay = document.getElementById("timeDisplay");
      let [minutes, seconds] = timeDisplay.textContent.split(":").map(Number);
      if (seconds > 0) {
        seconds--;
      } else if (minutes > 0) {
        minutes--;
        seconds = 59;
      }
      timeDisplay.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }, 1000);
  }
}

function stopTimer() {
  if (isRunning) {
    isRunning = false;
    clearInterval(intervalId);
  }
}

function resetTimer() {
  stopTimer();
  document.getElementById("timeDisplay").textContent = "25:00";
}

function initApp() {
  var root = document.getElementById("app");
  if (!root) return;

  const startButton = document.getElementById("startButton");
  const stopButton = document.getElementById("stopButton");
  const resetButton = document.getElementById("resetButton");

  if (startButton) {
    startButton.addEventListener("click", startTimer);
  }

  if (stopButton) {
    stopButton.addEventListener("click", stopTimer);
  }

  if (resetButton) {
    resetButton.addEventListener("click", resetTimer);
  }
}

document.addEventListener("DOMContentLoaded", initApp);