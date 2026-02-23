// script.js
const appState = {
  playerMove: null,
  computerMove: null,
  result: null
};

function handlePrimaryAction(event) {
  if (event) event.preventDefault();
}

function initApp() {
  const root = document.getElementById("app");
  if (!root) return;
  // Add event listeners for buttons
  const rockButton = document.getElementById("rockButton");
  const paperButton = document.getElementById("paperButton");
  const scissorsButton = document.getElementById("scissorsButton");
  rockButton.addEventListener("click", handleRockMove);
  paperButton.addEventListener("click", handlePaperMove);
  scissorsButton.addEventListener("click", handleScissorsMove);
}

function handleRockMove() {
  appState.playerMove = "rock";
  showResult();
}

function handlePaperMove() {
  appState.playerMove = "paper";
  showResult();
}

function handleScissorsMove() {
  appState.playerMove = "scissors";
  showResult();
}

function showResult() {
  const computerMove = determineComputerMove();
  appState.computerMove = computerMove;
  const result = determineResult();
  appState.result = result;

  // Update the display elements
  document.getElementById("playerMoveDisplay").textContent = `Your move: ${appState.playerMove}`;
  document.getElementById("computerMoveDisplay").textContent = `Computer's move: ${appState.computerMove}`;
  document.getElementById("resultDisplay").textContent = `Result: ${appState.result}`;
}

function determineComputerMove() {
  const moves = ["rock", "paper", "scissors"];
  const randomIndex = Math.floor(Math.random() * moves.length);
  return moves[randomIndex];
}

function determineResult() {
  if (appState.playerMove === appState.computerMove) {
    return "It's a tie!";
  } else if (appState.playerMove === "rock" && appState.computerMove === "paper") {
    return "Computer wins with Paper!";
  } else if (appState.playerMove === "paper" && appState.computerMove === "scissors") {
    return "Computer wins with Scissors!";
  } else if (appState.playerMove === "scissors" && appState.computerMove === "rock") {
    return "Computer wins with Rock!";
  } else {
    return "Invalid move or game logic error";
  }
}

document.addEventListener("DOMContentLoaded", initApp);