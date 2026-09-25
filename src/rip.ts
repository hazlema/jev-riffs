// The ripper: mine candidate units from an interval sequence, then have jev
// grade each one's musical significance on an ordered scale. The binary
// "genuine motif?" question saturates on music — everything the miner
// surfaces does repeat deliberately (seen live on Swan Lake: 20/20 yes) —
// so significance is a score, not a yes/no.
//
// Judgments are independent questions over the same state, so they ride in
// ONE batched request (chunked for safety) per the System One docs — 15
// sequential round trips took minutes when API latency wobbled; one batch
// takes one round trip and sends `intervals` once.

import { jev } from "./jev";
import { postSystemOne } from "./jev-client";
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
  tries: number; // API requests spent (batched)
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
  verbose = false,
  chunkSize = 10
): Promise<RipResult | Error> {
  const say = (m: string) => verbose && console.log(m);
  const candidates = findCandidates(intervals);
  say(`mined ${candidates.length} candidate(s)`);

  const motifs: Motif[] = [];
  let tries = 0;
  let budgetExhausted = false;

  for (let at = 0; at < candidates.length; at += chunkSize) {
    if (tries >= budget) {
      budgetExhausted = true;
      break;
    }
    tries++;
    const chunk = candidates.slice(at, at + chunkSize);
    const keys = chunk.map((_, i) => `c${i}`);
    const body = {
      model: "jev-latest",
      state: {
        intervals,
        candidates: Object.fromEntries(chunk.map((c, i) => [keys[i], c.unit])),
      },
      questions: Object.fromEntries(
        chunk.map((c, i) => [
          keys[i],
          {
            type: "score",
            instructions: {
              question: `\`intervals\` is a melody encoded as semitone steps between consecutive notes. How significant is \`candidates.${keys[i]}\` as a repeating musical motif within \`intervals\`?`,
              rule: "Judge the motif's musical role in this melody, from incidental to defining.",
            },
            criteria: SIGNIFICANCE_LEVELS,
          },
        ])
      ),
    };
    let raw: unknown;
    try {
      raw = await postSystemOne(body, fetchImpl);
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
    const answers = jev.parseAnswers(raw);
    for (let i = 0; i < chunk.length; i++) {
      const r = answers[keys[i]];
      if (!r) return new Error(`missing answer for candidate ${keys[i]}`);
      say(`[${chunk[i].unit.join(",")}]×${chunk[i].count} -> ${r.position} "${r.value}"`);
      motifs.push({
        unit: chunk[i].unit,
        count: chunk[i].count,
        significance: r.position ?? 0,
        label: r.value,
        occurrences: occurrencesOf(intervals, chunk[i].unit),
      });
    }
  }

  motifs.sort(
    (a, b) => b.significance - a.significance || b.count * b.unit.length - a.count * a.unit.length
  );
  return { motifs, tries, budgetExhausted };
}
