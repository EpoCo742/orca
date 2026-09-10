import { describe, expect, it } from 'vitest';
import { add, average, divide, multiply, subtract } from '../src/math.js';

describe('math', () => {
  it('adds', () => expect(add(2, 3)).toBe(5));
  it('subtracts', () => expect(subtract(5, 3)).toBe(2));
  it('multiplies', () => expect(multiply(4, 3)).toBe(12));
  it('divides exactly', () => expect(divide(10, 4)).toBe(2.5));
  it('divides negatives', () => expect(divide(-9, 3)).toBe(-3));
  it('throws on division by zero', () => expect(() => divide(1, 0)).toThrow(/zero/i));
  it('averages', () => expect(average([2, 4, 6])).toBe(4));
  it('averages empty as 0', () => expect(average([])).toBe(0));
});
