// The ripper: mine candidate units from an interval sequence, then have jev
// grade each one's musical significance on an ordered scale. The binary
// "genuine motif?" question saturates on music — everything the miner
// surfaces does repeat deliberately (seen live on Swan Lake: 20/20 yes) —
// so significance is a score, not a yes/no.

import { jev, QueryType } from "./jev";
import { findCandidates } from "./patterns";

export const SIGNIFICANCE_LEVELS = [
  "incidental overlap; repetition without musical identity",
  "small recurring figure or ornament; a building block",
  "recurring phrase; a full musical idea that repeats",
  "signature theme; the defining, memorable motif of the piece",
];

export interface Motif {
  unit: number[];
  count: number;
  significance: number; // weighted position on SIGNIFICANCE_LEVELS, 0..3
  label: string; // the winning level's description
  occurrences: number[]; // start indices in the interval sequence
}

export interface RipResult {
  motifs: Motif[];
  tries: number;
  budgetExhausted: boolean;
}

function occurrencesOf(seq: number[], unit: number[]): number[] {
  const out: number[] = [];
  for (let j = 0; j + unit.length <= seq.length; ) {
    if (unit.every((x, k) => seq[j + k] === x)) {
      out.push(j);
      j += unit.length;
    } else j++;
  }
  return out;
}

export async function rip(
  intervals: number[],
  budget = 100,
  fetchImpl: typeof fetch = fetch,
  verbose = false
): Promise<RipResult | Error> {
  const say = (m: string) => verbose && console.log(m);
  const candidates = findCandidates(intervals);
  say(`mined ${candidates.length} candidate(s)`);

  const motifs: Motif[] = [];
  let tries = 0;
  let budgetExhausted = false;

  for (const c of candidates) {
    if (tries >= budget) {
      budgetExhausted = true;
      break;
    }
    tries++;
    const r = await jev.send(
      jev.create(QueryType.score, {
        prompt: {
          question:
            "`intervals` is a melody encoded as semitone steps between consecutive notes. How significant is `candidate` as a repeating musical motif within `intervals`?",
          rule: "Judge the motif's musical role in this melody, from incidental to defining.",
        },
        levels: SIGNIFICANCE_LEVELS,
        state: { intervals, candidate: c.unit },
      }),
      fetchImpl
    );
    if (r instanceof Error) return r;
    if (r === null) return new Error("empty response from jev");
    say(`[${c.unit.join(",")}]×${c.count} -> ${r.position} "${r.value}"`);
    motifs.push({
      unit: c.unit,
      count: c.count,
      significance: r.position ?? 0,
      label: r.value,
      occurrences: occurrencesOf(intervals, c.unit),
    });
  }

  motifs.sort(
    (a, b) => b.significance - a.significance || b.count * b.unit.length - a.count * a.unit.length
  );
  return { motifs, tries, budgetExhausted };
}
