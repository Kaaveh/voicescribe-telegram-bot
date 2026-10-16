// Output guards (Constitution art. II; FR-025–027). Pure: no I/O.

export interface ValidationResult {
  ok: boolean;
  /** "LENGTH_GUARD" (FR-026), "SCRIPT_GUARD" (FR-027), "NGRAM_LOOP". */
  failures: string[];
  /** clean.length / raw.length — logged for FR-026 tuning. */
  lengthRatio: number;
}

export interface GuardBounds {
  min: number;
  max: number;
}

const ARABIC_YE_KAF = /[يك]/;

/** True when the same n-word sequence repeats `minRepeats` times in a row. */
export function hasNgramLoop(text: string, n = 3, minRepeats = 4): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i + n * minRepeats <= words.length; i++) {
    const gram = words.slice(i, i + n).join(' ');
    let reps = 1;
    while (words.slice(i + reps * n, i + (reps + 1) * n).join(' ') === gram) reps++;
    if (reps >= minRepeats) return true;
  }
  return false;
}

export function validate(raw: string, clean: string, bounds: GuardBounds): ValidationResult {
  const failures: string[] = [];
  const lengthRatio = raw.length === 0 ? (clean.length === 0 ? 1 : Infinity) : clean.length / raw.length;
  if (lengthRatio < bounds.min || lengthRatio > bounds.max) failures.push('LENGTH_GUARD');
  if (ARABIC_YE_KAF.test(clean)) failures.push('SCRIPT_GUARD');
  if (hasNgramLoop(clean)) failures.push('NGRAM_LOOP');
  return { ok: failures.length === 0, failures, lengthRatio };
}

export function parseBounds(min: string, max: string): GuardBounds {
  const b = { min: Number(min), max: Number(max) };
  if (!(b.min > 0 && b.max > b.min)) throw new Error(`Invalid LENGTH_GUARD bounds: ${min}/${max}`);
  return b;
}
