// Multi-pattern extraction, take two: code proposes, jev disposes.
//
// The greedy interrogation loop (pattern.ts) collapsed on a 42-number noisy
// sequence — one bad position pick poisoned `unit_so_far` and errors
// compounded for 85 calls. So the labor flips: CODE mines candidate units
// mechanically (it cannot be sweet-talked by noise), and jev makes one
// independent semantic judgment per candidate. No shared state, no poison.
//
// Run: bun src/patterns.ts [comma-separated sequence]

import { jev, QueryType } from "./jev";

export interface Candidate {
  unit: number[];
  count: number; // non-overlapping full occurrences in the sequence
}

export interface PatternsResult {
  patterns: Candidate[];
  tries: number; // jev calls spent
  budgetExhausted: boolean;
}

function equalsAt(seq: number[], unit: number[], at: number): boolean {
  for (let k = 0; k < unit.length; k++) if (seq[at + k] !== unit[k]) return false;
  return true;
}

function countNonOverlapping(seq: number[], unit: number[]): number {
  let count = 0;
  for (let j = 0; j + unit.length <= seq.length; ) {
    if (equalsAt(seq, unit, j)) {
      count++;
      j += unit.length;
    } else j++;
  }
  return count;
}

// [1,2,1,2] is just [1,2] twice — never a unit in its own right.
function isPeriodic(unit: number[]): boolean {
  for (let d = 1; d * 2 <= unit.length; d++) {
    if (unit.length % d !== 0) continue;
    if (unit.every((v, i) => v === unit[i % d])) return true;
  }
  return false;
}

function containsBlock(outer: number[], inner: number[]): boolean {
  for (let i = 0; i + inner.length <= outer.length; i++) {
    if (inner.every((v, k) => outer[i + k] === v)) return true;
  }
  return false;
}

// [2,1] is [1,2] caught mid-cycle — same pattern, different phase.
function isRotation(a: number[], b: number[]): boolean {
  return a.length === b.length && containsBlock([...a, ...a], b);
}

export function findCandidates(seq: number[], top = 20): Candidate[] {
  const seen = new Map<string, Candidate>();
  const maxLen = Math.floor(seq.length / 2);
  for (let len = 2; len <= maxLen; len++) {
    for (let i = 0; i + len <= seq.length; i++) {
      const unit = seq.slice(i, i + len);
      const key = unit.join(",");
      if (seen.has(key)) continue;
      const count = countNonOverlapping(seq, unit);
      if (count >= 2) seen.set(key, { unit, count });
    }
  }
  const all = [...seen.values()];
  const ranked = all
    .filter(
      // Shadow: a sub-block of a bigger candidate that never out-occurs it
      // (e.g. [7,3] inside [7,3,8,2,4], both ×3) adds nothing — drop it.
      (a) =>
        !all.some(
          (b) =>
            b.unit.length > a.unit.length && a.count <= b.count && containsBlock(b.unit, a.unit)
        )
    )
    .filter((c) => !isPeriodic(c.unit))
    .sort((x, y) => y.count * y.unit.length - x.count * x.unit.length);
  // Best-first dedupe: drop rotation echoes of a kept candidate, and
  // superstrings (e.g. unit + trailing noise) that don't out-cover the
  // kept unit they contain.
  const coverage = (c: Candidate) => c.count * c.unit.length;
  const kept: Candidate[] = [];
  for (const c of ranked) {
    const dominated = kept.some(
      (k) => isRotation(k.unit, c.unit) || (containsBlock(c.unit, k.unit) && coverage(c) <= coverage(k))
    );
    if (!dominated) kept.push(c);
  }
  return kept.slice(0, top);
}

export async function extractPatterns(
  seq: number[],
  budget = 100,
  fetchImpl: typeof fetch = fetch,
  verbose = false
): Promise<PatternsResult | Error> {
  const say = (m: string) => verbose && console.log(m);
  const rule =
    "A genuine repeating pattern's unit appears at least twice in full within `sequence` and reflects real repetition. A coincidental arrangement of unrelated or noise values is not a pattern.";

  const candidates = findCandidates(seq);
  say(`mined ${candidates.length} candidate(s): ${candidates.map((c) => `[${c.unit.join(",")}]×${c.count}`).join(" ")}`);

  const patterns: Candidate[] = [];
  let tries = 0;
  let budgetExhausted = false;

  for (const c of candidates) {
    if (tries >= budget) {
      budgetExhausted = true;
      break;
    }
    tries++;
    const r = await jev.send(
      jev.create(QueryType.question, {
        prompt: {
          question:
            "Is `candidate` a genuine repeating pattern within `sequence`, rather than a coincidental arrangement of unrelated values?",
          rule,
        },
        state: { sequence: seq, candidate: c.unit },
      }),
      fetchImpl
    );
    if (r instanceof Error) return r;
    if (r === null) return new Error("empty response from jev");
    say(`candidate [${c.unit.join(",")}]×${c.count} -> ${r.value} (p ${r.probabilities.true})`);
    if (r.value === "true") patterns.push(c);
  }

  return { patterns, tries, budgetExhausted };
}

if (import.meta.main) {
  const GAUNTLET = [6,1,0,5,9,7,3,8,2,4,1,1,6,0,8,7,3,8,2,4,5,0,3,2,9,6,9,0,7,3,8,2,4,1,7,0,4,4,2,8,6,5];
  const TWO_PATTERN = [1,2,1,2,1,2,5,7,8,9,7,8,9,0,1,2];
  const seqs = process.argv[2] ? [process.argv[2].split(",").map(Number)] : [GAUNTLET, TWO_PATTERN];
  for (const seq of seqs) {
    console.log(`\nsequence: [${seq.join(",")}]`);
    const start = performance.now();
    const res = await extractPatterns(seq, 100, fetch, true);
    const ms = Math.round(performance.now() - start);
    if (res instanceof Error) console.log(`error after ${ms}ms: ${res.message}`);
    else {
      const units = res.patterns.map((p) => `[${p.unit.join(",")}]×${p.count}`).join(" ") || "none";
      console.log(
        `result (${ms}ms, ${res.tries} tries${res.budgetExhausted ? ", budget exhausted" : ""}): ${units}`
      );
    }
  }
}
