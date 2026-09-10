export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  return a - b;
}

export function multiply(a, b) {
  return a * b;
}

// BUG (intentional, for the "fix until green" workflow): integer division is wrong
// for negative numbers and does not reject division by zero.
export function divide(a, b) {
  return Math.floor(a / b);
}

export function average(values) {
  if (values.length === 0) return 0;
  let total = 0;
  for (let i = 1; i < values.length; i++) {
    total += values[i];
  }
  return total / values.length;
}
