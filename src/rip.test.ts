import { test, expect } from "bun:test";
import { rip, SIGNIFICANCE_LEVELS } from "./rip";

function queuedFetch(bodies: unknown[], sent: any[] = []): typeof fetch {
  const queue = [...bodies];
  return (async (_url: any, init: any) => {
    sent.push(JSON.parse(init.body));
    const body = queue.shift();
    if (body === undefined) throw new Error("mock queue empty — too many requests");
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

// A live-shaped score answer: weighted position + winner level.
const scoreAns = (s: number, winner: number) => ({
  type: "score",
  score: s,
  confidence: 0.7,
  legend: Object.fromEntries(SIGNIFICANCE_LEVELS.map((l, i) => [String(i), l])),
  probabilities: Object.fromEntries(
    SIGNIFICANCE_LEVELS.map((_, i) => [String(i), i === winner ? 1 : 0])
  ),
});

// Candidates arrive deduped+ranked: [1,2]×4 then [7,8,9]×2.
const SEQ = [1, 2, 1, 2, 1, 2, 5, 7, 8, 9, 7, 8, 9, 0, 1, 2];

test("judges all candidates in one batched request and sorts by significance", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const sent: any[] = [];
  const script = queuedFetch(
    [{ answers: { c0: scoreAns(1.2, 1), c1: scoreAns(2.9, 3) } }],
    sent
  );
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
    tries: 1,
    budgetExhausted: false,
  });
  // one request, both questions aboard, state shared
  expect(sent.length).toBe(1);
  expect(Object.keys(sent[0].questions)).toEqual(["c0", "c1"]);
  expect(sent[0].state.intervals).toEqual(SEQ);
  expect(sent[0].state.candidates).toEqual({ c0: [1, 2], c1: [7, 8, 9] });
});

test("chunks respect the request budget and flag exhaustion", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  // chunkSize 1 → one request per candidate; budget 1 → second chunk unjudged
  const script = queuedFetch([{ answers: { c0: scoreAns(0.4, 0) } }]);
  const res = await rip(SEQ, 1, script, false, 1);
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

test("returns the Error when the request fails", async () => {
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

test("minNotes filters small candidates before any judging", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const sent: any[] = [];
  // [1,2] is 3 notes — filtered at minNotes 4; only [7,8,9] (4 notes) rides
  const script = queuedFetch([{ answers: { c0: scoreAns(2.9, 3) } }], sent);
  const res = await rip(SEQ, 100, script, false, 10, 4);
  expect(sent.length).toBe(1);
  expect(sent[0].state.candidates).toEqual({ c0: [7, 8, 9] });
  expect((res as any).motifs.map((m: any) => m.unit)).toEqual([[7, 8, 9]]);
});
