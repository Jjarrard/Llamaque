const counter = 0;

document.getElementById('counter').textContent = counter;

document.addEventListener('click', function(event) {
  if (event.target.classList.contains('plus')) {
    incrementCounter();
  } else if (event.target.classList.contains('minus')) {
    decrementCounter();
  }
});

function incrementCounter() {
  counter++;
  document.getElementById('counter').textContent = counter;
}

function decrementCounter() {
  counter--;
  document.getElementById('counter').textContent = counter;
}