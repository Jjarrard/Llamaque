// script.js
const appState = {
  passwordLength: 12,
  includeLetters: true,
  includeNumbers: true,
  includeSymbols: true
};

function handleGenerateButton(event) {
  event.preventDefault();
  const passwordLength = parseInt(document.getElementById('passwordLengthInput').value) || 12;
  const includeLetters = document.getElementById('includeLetters').checked;
  const includeNumbers = document.getElementById('includeNumbers').checked;
  const includeSymbols = document.getElementById('includeSymbols').checked;

  const characters = [];
  if (includeLetters) {
    characters.push('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
  }
  if (includeNumbers) {
    characters.push('0123456789');
  }
  if (includeSymbols) {
    characters.push('!@#$%^&*()_+-=[]{}|;:,.<>/?');
  }

  let password = '';
  for (let i = 0; i < passwordLength; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    password += characters[randomIndex][Math.floor(Math.random() * characters[randomIndex].length)];
  }

  const passwordOutputElement = document.createElement('p');
  passwordOutputElement.id = 'passwordOutput';
  passwordOutputElement.textContent = password;
  document.getElementById('app').appendChild(passwordOutputElement);
}

function initApp() {
  const app = document.getElementById('app');
  if (!app) return;

  const passwordLengthInput = document.getElementById('passwordLengthInput');
  passwordLengthInput.value = appState.passwordLength;

  const includeLettersCheckbox = document.getElementById('includeLetters');
  includeLettersCheckbox.checked = appState.includeLetters;

  const includeNumbersCheckbox = document.getElementById('includeNumbers');
  includeNumbersCheckbox.checked = appState.includeNumbers;

  const includeSymbolsCheckbox = document.getElementById('includeSymbols');
  includeSymbolsCheckbox.checked = appState.includeSymbols;

  const generateButton = document.createElement('button');
  generateButton.id = 'generateButton';
  generateButton.textContent = 'Generate Password';
  generateButton.addEventListener('click', handleGenerateButton);
  app.appendChild(generateButton);
}

document.addEventListener('DOMContentLoaded', initApp);