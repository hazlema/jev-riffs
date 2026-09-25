import { test, expect } from "bun:test";
import { rip, SIGNIFICANCE_LEVELS } from "./rip";

function queuedFetch(bodies: unknown[]): typeof fetch {
  const queue = [...bodies];
  return (async () => {
    const body = queue.shift();
    if (body === undefined) throw new Error("mock queue empty — judged too many candidates");
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

// A live-shaped score answer: weighted position + winner level.
const score = (s: number, winner: number) => ({
  answers: {
    answer: {
      type: "score",
      score: s,
      confidence: 0.7,
      legend: Object.fromEntries(SIGNIFICANCE_LEVELS.map((l, i) => [String(i), l])),
      probabilities: Object.fromEntries(
        SIGNIFICANCE_LEVELS.map((_, i) => [String(i), i === winner ? 1 : 0])
      ),
    },
  },
});

// Candidates arrive deduped+ranked: [1,2]×4 then [7,8,9]×2.
const SEQ = [1, 2, 1, 2, 1, 2, 5, 7, 8, 9, 7, 8, 9, 0, 1, 2];

test("grades candidates by score and sorts by significance", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const script = queuedFetch([score(1.2, 1), score(2.9, 3)]);
  const res = await rip(SEQ, 100, script);
  expect(res).toEqual({
    motifs: [
      {
        unit: [7, 8, 9],
        count: 2,
        significance: 2.9,
        label: SIGNIFICANCE_LEVELS[3],
        occurrences: [7, 10],
      },
      {
        unit: [1, 2],
        count: 4,
        significance: 1.2,
        label: SIGNIFICANCE_LEVELS[1],
        occurrences: [0, 2, 4, 14],
      },
    ],
    tries: 2,
    budgetExhausted: false,
  });
});

test("stops at the budget ceiling and flags it", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const res = await rip(SEQ, 1, queuedFetch([score(0.4, 0)]));
  expect(res).toEqual({
    motifs: [
      {
        unit: [1, 2],
        count: 4,
        significance: 0.4,
        label: SIGNIFICANCE_LEVELS[0],
        occurrences: [0, 2, 4, 14],
      },
    ],
    tries: 1,
    budgetExhausted: true,
  });
});

test("returns the Error when a judgment fails", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const broken = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  expect(await rip(SEQ, 100, broken)).toBeInstanceOf(Error);
});

test("empty sequence rips to no motifs with no jev calls", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  expect(await rip([9, 1, 7, 3, 0, 4], 100, queuedFetch([]))).toEqual({
    motifs: [],
    tries: 0,
    budgetExhausted: false,
  });
});
