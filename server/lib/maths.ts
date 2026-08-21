/**
 * Exact mathematics evaluator for the `eval_maths` tool.
 *
 * Parses and evaluates arithmetic expressions using BigInt-based rational
 * numbers, so results carry no floating-point error (0.1 + 0.2 is exactly
 * 0.3; 2^100 is exact; 1/3 stays an exact fraction). Irrational operations
 * (sqrt of non-squares, pi, trig, logs) fall back to IEEE doubles but are
 * flagged `approximate` in the result.
 *
 * Grammar (lowest → highest precedence):
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | '%') unary | <implicit '*'> unary)*
 *   unary   := ('+' | '-') unary | power
 *   power   := postfix ('^' unary)?          // right-associative, 2^-3 ok
 *   postfix := primary ('!' | '%')*          // factorial, percent
 *   primary := number | constant | func '(' args ')' | '(' expr ')'
 *
 * Implicit multiplication: `2(3+4)`, `2pi`, `(1+2)(3+4)` all work.
 * A `%` attached directly to a number (`50%`) is percent; a spaced `%`
 * between operands (`7 % 3`) is the modulo operator (use mod(a, b) to be
 * unambiguous).
 */

// --- Rationals -----------------------------------------------------------------

/** Rational number: n/d, d > 0, always reduced. */
interface Rational {
  n: bigint;
  d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

function makeRat(n: bigint, d: bigint): Rational {
  if (d === 0n) throw new MathError('Division by zero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}

const ONE: Rational = { n: 1n, d: 1n };

const rAdd = (a: Rational, b: Rational): Rational => makeRat(a.n * b.d + b.n * a.d, a.d * b.d);
const rSub = (a: Rational, b: Rational): Rational => makeRat(a.n * b.d - b.n * a.d, a.d * b.d);
const rMul = (a: Rational, b: Rational): Rational => makeRat(a.n * b.n, a.d * b.d);
const rDiv = (a: Rational, b: Rational): Rational => {
  if (b.n === 0n) throw new MathError('Division by zero');
  return makeRat(a.n * b.d, a.d * b.n);
};
const rNeg = (a: Rational): Rational => ({ n: -a.n, d: a.d });
const rAbs = (a: Rational): Rational => ({ n: a.n < 0n ? -a.n : a.n, d: a.d });
const rCmp = (a: Rational, b: Rational): number =>
  a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0;
const rIsInt = (a: Rational): boolean => a.d === 1n;
const rInt = (n: bigint): Rational => ({ n, d: 1n });

/** Integer sqrt via Newton's method: floor(sqrt(x)) for x >= 0. */
function isqrt(x: bigint): bigint {
  if (x < 0n) throw new MathError('sqrt of a negative number');
  if (x < 2n) return x;
  let g = 1n << BigInt(Math.ceil(bitLength(x) / 2));
  for (;;) {
    const next = (g + x / g) >> 1n;
    if (next >= g) break;
    g = next;
  }
  return g;
}

function bitLength(x: bigint): number {
  return (x < 0n ? -x : x).toString(2).length;
}

const digits10 = (x: bigint): number => (x < 0n ? -x : x).toString().length;

/** Convert a rational to a double for approximate functions (range-guarded). */
function rToNumber(a: Rational): number {
  const v = Number(a.n) / Number(a.d);
  if (!Number.isFinite(v)) {
    throw new MathError(
      `Value ${a.n}/${a.d} is outside the floating-point range needed for this approximate operation`,
    );
  }
  return v;
}

/** Convert a double back to the exact rational of its shortest decimal form. */
function numberToRat(x: number): Rational {
  if (!Number.isFinite(x)) throw new MathError('Result is not a finite number');
  let s = x.toString(); // may carry an exponent: "1e+21", "1.5e-11"
  let sign = false;
  if (s.startsWith('-')) {
    sign = true;
    s = s.slice(1);
  }
  const r = parseNumberLiteral(s);
  return sign ? rNeg(r) : r;
}

/** Parse a plain decimal string ("1.25", "-0.5") into a Rational. */
function parseDecimalRat(s: string): Rational {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) throw new MathError(`Invalid number: ${s}`);
  const sign = m[1] === '-' ? -1n : 1n;
  const frac = m[3] || '';
  const n = sign * BigInt((m[2] || '0') + frac || '0');
  return makeRat(n, 10n ** BigInt(frac.length));
}

// --- Values (rational + exactness flag) ------------------------------------------

interface Value {
  r: Rational;
  /** True when the value derives from an irrational/approximate operation. */
  approx: boolean;
}

const val = (r: Rational, approx = false): Value => ({ r, approx });
const anyApprox = (vs: Value[]): boolean => vs.some((v) => v.approx);
const vAdd = (a: Value, b: Value): Value => val(rAdd(a.r, b.r), a.approx || b.approx);
const vSub = (a: Value, b: Value): Value => val(rSub(a.r, b.r), a.approx || b.approx);
const vMul = (a: Value, b: Value): Value => val(rMul(a.r, b.r), a.approx || b.approx);
const vDiv = (a: Value, b: Value): Value => val(rDiv(a.r, b.r), a.approx || b.approx);
const vNeg = (a: Value): Value => val(rNeg(a.r), a.approx);

// --- Errors / limits --------------------------------------------------------------

export class MathError extends Error {}

const MAX_FACTORIAL = 20_000;
const MAX_EXPONENT = 100_000n;
/** Max digits of numerator+denominator a single operation may produce. */
const MAX_RESULT_DIGITS = 100_000;

function guardSize(r: Rational, what: string): void {
  if (digits10(r.n) + digits10(r.d) > MAX_RESULT_DIGITS) {
    throw new MathError(
      `${what} produces a result too large to compute (over ${MAX_RESULT_DIGITS} digits)`,
    );
  }
}

// --- Constants (50 significant digits, approximate) -------------------------------

const PI_50 = '3.1415926535897932384626433832795028841971693993751';
const E_50 = '2.7182818284590452353602874713526624977572470937000';
const PHI_50 = '1.6180339887498948482045868343656381177203091798058';

const PI_VAL = val(parseDecimalRat(PI_50), true);
const E_VAL = val(parseDecimalRat(E_50), true);

const CONSTANTS: Record<string, Value> = {
  pi: PI_VAL,
  tau: val(rMul(parseDecimalRat(PI_50), rInt(2n)), true),
  e: E_VAL,
  phi: val(parseDecimalRat(PHI_50), true),
};

// --- Exact helpers -----------------------------------------------------------------

function requireInt(r: Rational, name: string): bigint {
  if (!rIsInt(r)) throw new MathError(`${name} requires an integer argument, got ${r.n}/${r.d}`);
  return r.n;
}

/** Exact rational power with an integer exponent. */
function rPowInt(base: Rational, exp: bigint): Rational {
  if (exp < -MAX_EXPONENT || exp > MAX_EXPONENT) {
    throw new MathError(`Exponent too large (max ${MAX_EXPONENT})`);
  }
  const e = exp < 0n ? -exp : exp;
  if (
    Math.max(digits10(base.n), digits10(base.d)) * Number(e) > MAX_RESULT_DIGITS
  ) {
    throw new MathError('Exponentiation produces a result too large to compute');
  }
  let result = ONE;
  let b = base;
  let k = e;
  while (k > 0n) {
    if (k & 1n) result = rMul(result, b);
    k >>= 1n;
    if (k > 0n) b = rMul(b, b);
    guardSize(b, 'Exponentiation');
  }
  return exp < 0n ? rDiv(ONE, result) : result;
}

const rFloor = (r: Rational): bigint =>
  r.n >= 0n ? r.n / r.d : (r.n - r.d + 1n) / r.d;
const rCeil = (r: Rational): bigint => -rFloor(rNeg(r));

/** Exact rounding (half away from zero) to `digits` decimal places. */
function rRound(r: Rational, digits: number): Rational {
  if (digits > 1000 || digits < -1000) {
    throw new MathError('round() digits must be between -1000 and 1000');
  }
  const scale = 10n ** BigInt(Math.abs(digits));
  const abs = rAbs(r);
  const scaled = digits >= 0 ? rMul(abs, rInt(scale)) : rDiv(abs, rInt(scale));
  let q = rFloor(scaled);
  const frac = rSub(scaled, rInt(q));
  if (rCmp(frac, val_1_2.r) >= 0) q += 1n; // half away from zero
  let out = rInt(q);
  if (digits >= 0) out = rDiv(out, rInt(scale));
  else out = rMul(out, rInt(scale));
  return r.n < 0n ? rNeg(out) : out;
}
const val_1_2: Value = val({ n: 1n, d: 2n });

/** Exact sqrt when both numerator and denominator are perfect squares. */
function sqrtExact(r: Rational): Rational | null {
  if (r.n < 0n) throw new MathError('sqrt of a negative number');
  const sn = isqrt(r.n);
  const sd = isqrt(r.d);
  if (sn * sn !== r.n || sd * sd !== r.d) return null;
  return makeRat(sn, sd);
}

function factorial(n: bigint): bigint {
  if (n < 0n) throw new MathError('Factorial of a negative number');
  if (n > BigInt(MAX_FACTORIAL)) {
    throw new MathError(`Factorial argument too large (max ${MAX_FACTORIAL})`);
  }
  let out = 1n;
  for (let i = 2n; i <= n; i++) out *= i;
  return out;
}

function comb(n: bigint, k: bigint): bigint {
  if (n < 0n || k < 0n) throw new MathError('comb() requires non-negative integers');
  if (k > n) return 0n;
  if (n > 100_000n) throw new MathError('comb() arguments too large (max 100000)');
  const kk = k > n - k ? n - k : k; // symmetry
  let out = 1n;
  for (let i = 0n; i < kk; i++) {
    out = (out * (n - i)) / (i + 1n);
    if (digits10(out) > MAX_RESULT_DIGITS) throw new MathError('comb() result too large');
  }
  return out;
}

// --- Shared power -------------------------------------------------------------------

/** pow for Values: exact for integer exponents, approximate otherwise. */
function powValue(base: Value, exp: Value): Value {
  if (rIsInt(exp.r)) return val(rPowInt(base.r, exp.r.n), base.approx || exp.approx);
  return approxResult([base, exp], ([x, y]) => x ** y);
}

// --- Function table ------------------------------------------------------------------

interface FuncDef {
  minArgs: number;
  maxArgs: number;
  fn: (args: Value[]) => Value;
}

/** Run a double-based computation; the result is always approximate. */
function approxResult(args: Value[], f: (xs: number[]) => number): Value {
  const out = f(args.map((a) => rToNumber(a.r)));
  if (!Number.isFinite(out)) throw new MathError('Result is not a finite number');
  return val(numberToRat(out), true);
}

const FUNCTIONS: Record<string, FuncDef> = {
  abs: { minArgs: 1, maxArgs: 1, fn: ([a]) => val(rAbs(a.r), a.approx) },
  min: {
    minArgs: 1,
    maxArgs: 16,
    fn: (as) => {
      let best = as[0]!;
      for (const a of as) if (rCmp(a.r, best.r) < 0) best = a;
      return val(best.r, anyApprox(as));
    },
  },
  max: {
    minArgs: 1,
    maxArgs: 16,
    fn: (as) => {
      let best = as[0]!;
      for (const a of as) if (rCmp(a.r, best.r) > 0) best = a;
      return val(best.r, anyApprox(as));
    },
  },
  gcd: {
    minArgs: 2,
    maxArgs: 16,
    fn: (as) => {
      let g = 0n;
      for (const a of as) {
        const x = requireInt(a.r, 'gcd() argument');
        g = gcd(g, x);
      }
      return val(rInt(g), anyApprox(as));
    },
  },
  lcm: {
    minArgs: 2,
    maxArgs: 16,
    fn: (as) => {
      let l = rAbs(as[0]!.r).n;
      for (const a of as.slice(1)) {
        const x = requireInt(rAbs(a.r), 'lcm() argument');
        l = (l / gcd(l, x)) * x;
        guardSize(rInt(l), 'lcm()');
      }
      return val(rInt(l), anyApprox(as));
    },
  },
  mod: {
    minArgs: 2,
    maxArgs: 2,
    fn: ([a, b]) => {
      if (b.r.n === 0n) throw new MathError('mod() by zero');
      // Floored modulo: a - b * floor(a/b) — sign follows the divisor.
      return vSub(a, vMul(b, val(rInt(rFloor(rDiv(a.r, b.r))))));
    },
  },
  pow: { minArgs: 2, maxArgs: 2, fn: ([a, b]) => powValue(a, b) },
  sqrt: {
    minArgs: 1,
    maxArgs: 1,
    fn: ([a]) => {
      const exact = sqrtExact(a.r);
      if (exact) return val(exact, a.approx);
      return approxResult([a], ([x]) => Math.sqrt(x));
    },
  },
  cbrt: {
    minArgs: 1,
    maxArgs: 1,
    fn: ([a]) => {
      // Exact for perfect cubes.
      if (a.r.n >= 0n) {
        const ic = icbrt(a.r.n);
        const dc = icbrt(a.r.d);
        if (ic * ic * ic === a.r.n && dc * dc * dc === a.r.d) {
          return val(makeRat(ic, dc), a.approx);
        }
      }
      return approxResult([a], ([x]) => Math.cbrt(x));
    },
  },
  floor: { minArgs: 1, maxArgs: 1, fn: ([a]) => val(rInt(rFloor(a.r)), a.approx) },
  ceil: { minArgs: 1, maxArgs: 1, fn: ([a]) => val(rInt(rCeil(a.r)), a.approx) },
  trunc: {
    minArgs: 1,
    maxArgs: 1,
    fn: ([a]) => val(rInt(a.r.n / a.r.d), a.approx),
  },
  round: {
    minArgs: 1,
    maxArgs: 2,
    fn: ([a, b]) => {
      const digits = b === undefined ? 0 : Number(requireInt(b.r, 'round() digits'));
      return val(rRound(a.r, digits), a.approx || (b?.approx ?? false));
    },
  },
  sign: {
    minArgs: 1,
    maxArgs: 1,
    fn: ([a]) => val(rInt(a.r.n === 0n ? 0n : a.r.n < 0n ? -1n : 1n), a.approx),
  },
  fact: {
    minArgs: 1,
    maxArgs: 1,
    fn: ([a]) => val(rInt(factorial(requireInt(a.r, 'fact()'))), a.approx),
  },
  comb: {
    minArgs: 2,
    maxArgs: 2,
    fn: ([n, k]) =>
      val(
        rInt(comb(requireInt(n.r, 'comb() n'), requireInt(k.r, 'comb() k'))),
        n.approx || k.approx,
      ),
  },
  // Degree/radian conversion — involves pi, so always approximate.
  deg: {
    minArgs: 1,
    maxArgs: 1,
    fn: ([a]) => vDiv(vMul(a, val(rInt(180n))), PI_VAL),
  },
  rad: {
    minArgs: 1,
    maxArgs: 1,
    fn: ([a]) => vDiv(vMul(a, PI_VAL), val(rInt(180n))),
  },
  // Approximate (double-based) functions.
  exp: { minArgs: 1, maxArgs: 1, fn: (as) => approxResult(as, ([x]) => Math.exp(x)) },
  ln: { minArgs: 1, maxArgs: 1, fn: (as) => approxResult(as, ([x]) => Math.log(x)) },
  log: {
    minArgs: 1,
    maxArgs: 2,
    fn: (as) =>
      approxResult(as, as.length === 2 ? ([x, b]) => Math.log(x) / Math.log(b) : ([x]) => Math.log(x)),
  },
  log2: { minArgs: 1, maxArgs: 1, fn: (as) => approxResult(as, ([x]) => Math.log2(x)) },
  log10: { minArgs: 1, maxArgs: 1, fn: (as) => approxResult(as, ([x]) => Math.log10(x)) },
  sin: { minArgs: 1, maxArgs: 1, fn: (as) => approxResult(as, ([x]) => Math.sin(x)) },
  cos: { minArgs: 1, maxArgs: 1, fn: (as) => approxResult(as, ([x]) => Math.cos(x)) },
  tan: { minArgs: 1, maxArgs: 1, fn: (as) => approxResult(as, ([x]) => Math.tan(x)) },
  asin: { minArgs: 1, maxArgs: 1, fn: (as) => approxResult(as, ([x]) => Math.asin(x)) },
  acos: { minArgs: 1, maxArgs: 1, fn: (as) => approxResult(as, ([x]) => Math.acos(x)) },
  atan: { minArgs: 1, maxArgs: 1, fn: (as) => approxResult(as, ([x]) => Math.atan(x)) },
  sinh: { minArgs: 1, maxArgs: 1, fn: (as) => approxResult(as, ([x]) => Math.sinh(x)) },
  cosh: { minArgs: 1, maxArgs: 1, fn: (as) => approxResult(as, ([x]) => Math.cosh(x)) },
  tanh: { minArgs: 1, maxArgs: 1, fn: (as) => approxResult(as, ([x]) => Math.tanh(x)) },
};
FUNCTIONS.binom = FUNCTIONS.comb;
FUNCTIONS.factorial = FUNCTIONS.fact;

/** Integer cube root: floor(cbrt(x)) for x >= 0. */
function icbrt(x: bigint): bigint {
  if (x < 2n) return x;
  let g = 1n << BigInt(Math.ceil(bitLength(x) / 3));
  for (;;) {
    const g2 = g * g;
    const next = (2n * g + x / g2) / 3n;
    if (next >= g) break;
    g = next;
  }
  // Newton can land one too high — verify.
  while (g * g * g > x) g -= 1n;
  while ((g + 1n) ** 3n <= x) g += 1n;
  return g;
}

// --- Tokenizer --------------------------------------------------------------------------

type Token =
  | { t: 'num'; r: Rational }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string } // + - * / % ^ ! ( ) , pct
  | { t: 'end' };

const UNICODE_OPS: [RegExp, string][] = [
  [/×/g, '*'],
  [/·/g, '*'],
  [/÷/g, '/'],
  [/[−–—]/g, '-'],
  [/π/g, ' pi '],
  [/φ/g, ' phi '],
];

function tokenize(src: string): Token[] {
  let s = src;
  for (const [re, rep] of UNICODE_OPS) s = s.replace(re, rep);
  s = s.replace(/\*\*/g, '^');

  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      let j = i;
      while (j < s.length && /[0-9]/.test(s[j]!)) j++;
      if (s[j] === '.') {
        j++;
        while (j < s.length && /[0-9]/.test(s[j]!)) j++;
      }
      // Scientific notation — only if 'e'/'E' starts a valid exponent
      // (so `2e` still parses as 2·e, the constant).
      if (
        (s[j] === 'e' || s[j] === 'E') &&
        (/[0-9]/.test(s[j + 1] ?? '') ||
          ((s[j + 1] === '+' || s[j + 1] === '-') && /[0-9]/.test(s[j + 2] ?? '')))
      ) {
        j += 2; // e + first exponent digit or sign
        while (j < s.length && /[0-9]/.test(s[j]!)) j++;
      }
      const lit = s.slice(i, j);
      if (lit.replace(/[-+.eE]/g, '').length > 10_000) {
        throw new MathError('Number literal too long');
      }
      tokens.push({ t: 'num', r: parseNumberLiteral(lit) });
      i = j;
      // Percent attached directly to the number: `50%`, `12.5%`.
      if (s[i] === '%') {
        tokens.push({ t: 'op', v: 'pct' });
        i++;
      }
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Z_0-9]/.test(s[j]!)) j++;
      tokens.push({ t: 'id', v: s.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/%^!(),'.includes(c)) {
      tokens.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new MathError(`Unexpected character "${c}" at position ${i + 1}`);
  }
  tokens.push({ t: 'end' });
  return tokens;
}

function parseNumberLiteral(lit: string): Rational {
  const m = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(lit);
  if (!m) throw new MathError(`Invalid number: ${lit}`);
  const frac = m[2] || '';
  let r = makeRat(BigInt((m[1] || '0') + frac || '0'), 10n ** BigInt(frac.length));
  const exp = m[3] ? BigInt(m[3]) : 0n;
  if (exp !== 0n) {
    if (exp > 10_000n || exp < -10_000n) throw new MathError('Exponent in number literal too large');
    const p = rPowInt(rInt(10n), exp < 0n ? -exp : exp);
    r = exp > 0n ? rMul(r, p) : rDiv(r, p);
  }
  return r;
}

// --- Parser --------------------------------------------------------------------------------

class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectOp(v: string): void {
    const t = this.next();
    if (t.t !== 'op' || t.v !== v) {
      throw new MathError(
        t.t === 'end' ? `Expected "${v}" but reached the end of the expression` : `Expected "${v}"`,
      );
    }
  }

  parse(): Value {
    const v = this.expr();
    const t = this.peek();
    if (t.t !== 'end') {
      throw new MathError(
        t.t === 'num' ? 'Unexpected number' : t.t === 'id' ? `Unexpected "${t.v}"` : `Unexpected "${t.v}"`,
      );
    }
    return v;
  }

  private expr(): Value {
    let left = this.term();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && (t.v === '+' || t.v === '-')) {
        this.next();
        const right = this.term();
        left = t.v === '+' ? vAdd(left, right) : vSub(left, right);
      } else break;
    }
    return left;
  }

  private term(): Value {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '%')) {
        this.next();
        const right = this.unary();
        if (t.v === '*') left = vMul(left, right);
        else if (t.v === '/') left = vDiv(left, right);
        else {
          if (right.r.n === 0n) throw new MathError('Modulo by zero');
          // Floored modulo, same as mod().
          left = vSub(left, vMul(right, val(rInt(rFloor(rDiv(left.r, right.r))))));
        }
      } else if (t.t === 'num' || t.t === 'id' || (t.t === 'op' && t.v === '(')) {
        // Implicit multiplication: 2pi, 2(3+4), (1+2)(3+4)
        left = vMul(left, this.unary());
      } else break;
    }
    return left;
  }

  private unary(): Value {
    const t = this.peek();
    if (t.t === 'op' && (t.v === '+' || t.v === '-')) {
      this.next();
      const operand = this.unary();
      return t.v === '-' ? vNeg(operand) : operand;
    }
    return this.power();
  }

  private power(): Value {
    const base = this.postfix();
    const t = this.peek();
    if (t.t === 'op' && t.v === '^') {
      this.next();
      return powValue(base, this.unary()); // right-assoc, allows 2^-3
    }
    return base;
  }

  private postfix(): Value {
    let v = this.primary();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && t.v === '!') {
        this.next();
        v = val(rInt(factorial(requireInt(v.r, '!'))), v.approx);
      } else if (t.t === 'op' && t.v === 'pct') {
        this.next();
        v = vDiv(v, val(rInt(100n)));
      } else break;
    }
    return v;
  }

  private primary(): Value {
    const t = this.next();
    if (t.t === 'num') return val(t.r);
    if (t.t === 'id') {
      const name = t.v.toLowerCase();
      const fn = FUNCTIONS[name];
      if (fn) {
        this.expectOp('(');
        const args: Value[] = [];
        const first = this.peek();
        if (!(first.t === 'op' && first.v === ')')) {
          for (;;) {
            args.push(this.expr());
            const sep = this.next();
            if (sep.t === 'op' && sep.v === ',') continue;
            if (sep.t === 'op' && sep.v === ')') break;
            throw new MathError(`Expected "," or ")" in ${name}() arguments`);
          }
        } else {
          this.next(); // consume ')'
        }
        if (args.length < fn.minArgs || args.length > fn.maxArgs) {
          throw new MathError(
            `${name}() expects ${fn.minArgs === fn.maxArgs ? fn.minArgs : `${fn.minArgs}-${fn.maxArgs}`} argument(s), got ${args.length}`,
          );
        }
        return fn.fn(args);
      }
      const constant = CONSTANTS[name];
      if (constant) return constant;
      throw new MathError(`Unknown identifier "${t.v}"`);
    }
    if (t.t === 'op' && t.v === '(') {
      const v = this.expr();
      this.expectOp(')');
      return v;
    }
    throw new MathError(t.t === 'end' ? 'Unexpected end of expression' : `Unexpected "${t.v}"`);
  }
}

// --- Formatting ------------------------------------------------------------------------------

const DECIMAL_PRECISION = 30;

/** Exact decimal expansion when the denominator is 2^a·5^b; else null. */
function terminatingDecimal(r: Rational): string | null {
  let d = r.d;
  while (d % 2n === 0n) d /= 2n;
  while (d % 5n === 0n) d /= 5n;
  if (d !== 1n) return null;
  // places = max(a, b) makes n * 10^places / d an exact integer.
  let a = 0;
  let b = 0;
  let dd = r.d;
  while (dd % 2n === 0n) {
    dd /= 2n;
    a++;
  }
  while (dd % 5n === 0n) {
    dd /= 5n;
    b++;
  }
  const places = Math.max(a, b);
  const scaled = (rAbs(r).n * 10n ** BigInt(places)) / r.d;
  let s = scaled.toString().padStart(places + 1, '0');
  if (places > 0) s = s.slice(0, s.length - places) + '.' + s.slice(s.length - places);
  if (r.n < 0n && scaled !== 0n) s = '-' + s;
  return s;
}

/** Decimal rendering: exact for integers/terminating decimals, else rounded to 30 significant digits. */
function decimalString(r: Rational): string {
  if (r.n === 0n) return '0';
  if (rIsInt(r)) return r.n.toString();
  const term = terminatingDecimal(r);
  if (term !== null) return term;

  // |n|/d rounded to DECIMAL_PRECISION significant digits.
  const abs = rAbs(r);
  const dn = digits10(abs.n);
  const dd = digits10(abs.d);
  const scale = BigInt(DECIMAL_PRECISION + 10 + Math.max(0, dd - dn));
  const q = (abs.n * 10n ** scale + abs.d / 2n) / abs.d;
  const D = digits10(q);
  let digits = q.toString();
  // q has D digits and value = q * 10^-scale, so `point` digits come before
  // the decimal point.
  let point = D - Number(scale);
  if (digits.length > DECIMAL_PRECISION) {
    const drop = BigInt(D - DECIMAL_PRECISION);
    const p = 10n ** drop;
    const rounded = (q + p / 2n) / p;
    digits = rounded.toString();
    // Rounding 999…9 up adds a digit (value carried into the next place).
    if (digits.length > DECIMAL_PRECISION) point += 1;
  }
  digits = digits.replace(/0+$/, '') || '0';
  let out: string;
  if (point <= 0) {
    out = '0.' + '0'.repeat(-point) + digits;
  } else if (point >= digits.length) {
    out = digits + '0'.repeat(point - digits.length) + '.0';
  } else {
    out = digits.slice(0, point) + '.' + digits.slice(point);
  }
  return (r.n < 0n ? '-' : '') + out;
}

export interface MathsResult {
  expression: string;
  /** Primary rendering: integer, exact decimal, or "n/d" fraction. */
  result: string;
  /** Decimal rendering (exact when terminating, else rounded to 30 sig digits). */
  decimal: string;
  /** Exact fraction form, present when the value is not an integer. */
  fraction?: string;
  /** True when the value derives from irrational/approximate operations. */
  approximate: boolean;
}

/** Evaluate a maths expression. Returns the result, or `{ error }` on failure. */
export function evalMaths(expression: string): MathsResult | { error: string } {
  try {
    const tokens = tokenize(expression);
    if (tokens.length === 1 && tokens[0]!.t === 'end') {
      return { error: 'Expression is empty' };
    }
    const { r, approx } = new Parser(tokens).parse();

    const decimal = decimalString(r);
    let result: string;
    if (approx) {
      result = decimal;
    } else if (rIsInt(r)) {
      result = r.n.toString();
    } else {
      const term = terminatingDecimal(r);
      result = term ?? `${r.n}/${r.d}`;
    }
    return {
      expression,
      result,
      decimal,
      ...(rIsInt(r) ? {} : { fraction: `${r.n}/${r.d}` }),
      approximate: approx,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
