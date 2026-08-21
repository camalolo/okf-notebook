import { describe, expect, it } from 'vitest';
import { evalMaths } from './maths.js';

const res = (expr: string) => evalMaths(expr) as {
  result: string;
  decimal: string;
  fraction?: string;
  approximate: boolean;
};
const err = (expr: string) => (evalMaths(expr) as { error: string }).error;

describe('evalMaths — exact arithmetic', () => {
  it('computes decimals without floating-point error', () => {
    expect(res('0.1 + 0.2').result).toBe('0.3');
    expect(res('0.1 + 0.2').approximate).toBe(false);
    expect(res('1.1 * 3').result).toBe('3.3');
    expect(res('1 - 0.9').result).toBe('0.1');
  });

  it('handles big integers exactly', () => {
    expect(res('2^100').result).toBe('1267650600228229401496703205376');
    expect(res('99999999999999999999 + 1').result).toBe('100000000000000000000');
    expect(res('123456789 * 987654321').result).toBe('121932631112635269');
  });

  it('keeps exact fractions', () => {
    expect(res('1/3 + 1/6').result).toBe('0.5'); // terminating → exact decimal
    expect(res('1/3 + 1/6').fraction).toBe('1/2');
    expect(res('1/3').result).toBe('1/3');
    expect(res('1/3').fraction).toBe('1/3');
    expect(res('1/3').decimal.startsWith('0.3333')).toBe(true);
    expect(res('10/4').result).toBe('2.5');
    expect(res('1/8').result).toBe('0.125');
  });

  it('rounds non-terminating decimals to 30 significant digits', () => {
    const r = res('1/7');
    expect(r.decimal.startsWith('0.142857142857142857142857142857')).toBe(true);
    expect(r.decimal.length).toBeLessThanOrEqual(33); // "0." + 30 digits + slack
  });
});

describe('evalMaths — precedence and syntax', () => {
  it('respects operator precedence', () => {
    expect(res('2 + 3 * 4').result).toBe('14');
    expect(res('(2 + 3) * 4').result).toBe('20');
    expect(res('2 + 3 * 4^2').result).toBe('50');
  });

  it('handles powers correctly', () => {
    expect(res('2^3^2').result).toBe('512'); // right-associative
    expect(res('-2^2').result).toBe('-4'); // unary minus binds looser than ^
    expect(res('2^-3').result).toBe('0.125');
    expect(res('(-2)^2').result).toBe('4');
  });

  it('supports scientific notation', () => {
    expect(res('1.5e3').result).toBe('1500');
    expect(res('2e-2').result).toBe('0.02');
    // `2e` is 2·e (Euler), not scientific notation.
    expect(res('2e').approximate).toBe(true);
  });

  it('supports implicit multiplication', () => {
    expect(res('2(3+4)').result).toBe('14');
    expect(res('(1+2)(3+4)').result).toBe('21');
    expect(res('2pi').approximate).toBe(true);
  });

  it('supports unicode operators and constants', () => {
    expect(res('3 × 4').result).toBe('12');
    expect(res('8 ÷ 2').result).toBe('4');
    expect(res('π').approximate).toBe(true);
  });

  it('supports modulo and percent distinctly', () => {
    expect(res('7 % 3').result).toBe('1');
    expect(res('17 % 5').result).toBe('2');
    expect(res('50%').result).toBe('0.5');
    expect(res('15% * 200').result).toBe('30');
    expect(res('50 + 10%').result).toBe('50.1');
  });
});

describe('evalMaths — functions', () => {
  it('exact functions', () => {
    expect(res('sqrt(16)').result).toBe('4');
    expect(res('sqrt(2.25)').result).toBe('1.5');
    expect(res('sqrt(1/4)').result).toBe('0.5');
    expect(res('gcd(12, 18)').result).toBe('6');
    expect(res('gcd(12, 18, 30)').result).toBe('6');
    expect(res('lcm(4, 6)').result).toBe('12');
    expect(res('mod(7, 3)').result).toBe('1');
    expect(res('mod(-7, 3)').result).toBe('2'); // floored modulo
    expect(res('abs(-5)').result).toBe('5');
    expect(res('max(1/2, 0.3)').result).toBe('0.5');
    expect(res('min(3, 2, 5)').result).toBe('2');
    expect(res('floor(-2.5)').result).toBe('-3');
    expect(res('ceil(-2.5)').result).toBe('-2');
    expect(res('floor(2.5)').result).toBe('2');
    expect(res('ceil(2.5)').result).toBe('3');
    expect(res('trunc(-2.7)').result).toBe('-2');
    expect(res('sign(-3)').result).toBe('-1');
    expect(res('pow(2, 10)').result).toBe('1024');
    expect(res('pow(2, -2)').result).toBe('0.25');
    expect(res('round(2/3, 4)').result).toBe('0.6667');
    expect(res('round(2.5)').result).toBe('3'); // half away from zero
    expect(res('round(-2.5)').result).toBe('-3');
    expect(res('round(1234, -2)').result).toBe('1200');
    expect(res('comb(52, 5)').result).toBe('2598960');
    expect(res('comb(10, 0)').result).toBe('1');
    expect(res('binom(5, 2)').result).toBe('10');
  });

  it('factorials', () => {
    expect(res('5!').result).toBe('120');
    expect(res('0!').result).toBe('1');
    expect(res('20!').result).toBe('2432902008176640000');
    expect(res('fact(10)').result).toBe('3628800');
  });

  it('flags approximate results', () => {
    expect(res('sqrt(2)').approximate).toBe(true);
    expect(res('sqrt(2)').result.startsWith('1.4142135623731')).toBe(true); // 15-digit snap
    expect(res('pi').approximate).toBe(true);
    expect(res('2*pi').approximate).toBe(true);
    expect(res('ln(10)').approximate).toBe(true);
    expect(res('log10(1000)').approximate).toBe(true);
    expect(res('sin(0)').result).toBe('0'); // exact zero, but via double → approx flag
    expect(res('sin(0)').approximate).toBe(true);
    expect(res('2*pi').decimal.startsWith('6.283185307179586')).toBe(true);
    expect(res('exp(1)').approximate).toBe(true);
    expect(res('pow(2, 0.5)').approximate).toBe(true);
    expect(res('max(pi, 3)').approximate).toBe(true);
    // Exactness propagates through mixed expressions.
    expect(res('1 + sqrt(4)').approximate).toBe(false);
    expect(res('1 + sqrt(4)').result).toBe('3');
  });

  it('snaps double-based results to 15 significant digits (float64 noise cleanup)', () => {
    expect(res('sqrt(2)^2').result).toBe('2'); // was 2.000000000000000444…
    expect(res('sin(pi/6)').result).toBe('0.5'); // was 0.49999999999999994
    expect(res('cbrt(-8)').result).toBe('-2');
    // Purely rational chains of approximate constants keep their honest
    // digits (constants are computed to 120 at load) — only double-based
    // functions are snapped.
    expect(res('2*pi*6371').decimal.length).toBeGreaterThan(20);
  });

  it('computed constants match known digit prefixes', () => {
    // pi to 50 significant digits (classic 100-digit grouping).
    expect(res('pi').decimal).toBe('3.1415926535897932384626433832795028841971693993751');
    expect(res('tau').decimal.startsWith('6.283185307179586476925286766559')).toBe(true);
    // e — verify the unambiguous prefix from the series definition.
    expect(res('e').decimal.startsWith('2.718281828459045235360287471352662497757247093')).toBe(true);
    // phi = (1+sqrt(5))/2.
    expect(res('phi').decimal.startsWith('1.61803398874989484820458683436563811772030917980')).toBe(true);
    // tau is exactly 2·pi (same rational, doubled).
    expect(res('pi').approximate).toBe(true);
  });

  it('snaps trig dust to zero (special angles on pi)', () => {
    expect(res('sin(pi)').result).toBe('0'); // was 1.22e-16
    expect(res('cos(pi/2)').result).toBe('0'); // 6.1e-17
    expect(res('sind(180)').result).toBe('0');
    expect(res('cosd(90)').result).toBe('0');
    // Genuinely small results are preserved.
    expect(res('sin(0.001)').decimal.startsWith('0.000999999833333342')).toBe(true);
    expect(res('sin(1e-10)').result).not.toBe('0');
  });

  it('phi identities come out clean with computed constants', () => {
    // phi² = phi + 1 exactly; with 120-digit constants the truncation dust
    // sits far beyond the 50-digit render, so this shows a clean 1.0.
    expect(res('phi^2 - phi').result).toBe('1.0');
  });

  it('degree-based trig: sind/cosd/tand and inverses', () => {
    expect(res('sind(30)').result).toBe('0.5');
    expect(res('sind(90)').result).toBe('1');
    expect(res('cosd(60)').result).toBe('0.5');
    expect(res('tand(45)').result).toBe('1');
    expect(res('asind(0.5)').result).toBe('30');
    expect(res('atand(1)').result).toBe('45');
    expect(res('sind(30)').approximate).toBe(true);
  });

  it('gives a helpful error for negative bases with fractional exponents', () => {
    expect(err('(-8)^(1/3)')).toMatch(/cbrt|real/i);
  });

  it('truncates huge renders with a note (keeps tool output bounded)', () => {
    const r = evalMaths('2^4000') as { result: string; approximate: boolean; fraction?: string };
    expect(r.approximate).toBe(false);
    expect(r.result).toContain('truncated');
    expect(r.result.length).toBeLessThan(1100);
  });
});

describe('evalMaths — errors', () => {
  it('rejects malformed expressions', () => {
    expect(err('1/0')).toMatch(/Division by zero/);
    expect(err('5 % 0')).toMatch(/Modulo by zero/);
    expect(err('(1+2')).toMatch(/Expected "\)"/);
    expect(err('1 + 2)')).toMatch(/Unexpected/);
    expect(err('foo(3)')).toMatch(/Unknown identifier "foo"/);
    expect(err('')).toMatch(/empty/);
    expect(err('2 +')).toMatch(/Unexpected end/);
    expect(err('sqrt(1, 2)')).toMatch(/sqrt\(\) expects/);
    expect(err('abc')).toMatch(/Unknown identifier/);
    expect(err('2 @ 3')).toMatch(/Unexpected character/);
  });

  it('rejects out-of-domain and oversized inputs', () => {
    expect(err('sqrt(-4)')).toMatch(/negative/);
    expect(err('ln(0)')).toMatch(/not a finite|floating-point/);
    expect(err('(-2)!')).toMatch(/integer|negative/);
    expect(err('1.5!')).toMatch(/integer/);
    expect(err('100001!')).toMatch(/too large/i);
    expect(err('2^99999999999')).toMatch(/too large/i);
  });
});
