import { test, expect } from "bun:test";
import { findCandidates, extractPatterns } from "./patterns";

// --- findCandidates (pure code, no API) ---

test("finds a repeating unit and prunes its sub-block shadows", () => {
  // [5,6] and [6,7] repeat exactly as often as [5,6,7] — shadows, pruned.
  expect(findCandidates([5, 6, 7, 5, 6, 7])).toEqual([{ unit: [5, 6, 7], count: 2 }]);
});

test("drops doubled/periodic units", () => {
  const units = findCandidates([1, 2, 1, 2, 1, 2, 1, 2]).map((c) => c.unit.join(","));
  expect(units).toContain("1,2");
  expect(units).not.toContain("1,2,1,2");
});

test("ranks by coverage and finds multiple distinct units", () => {
  const seq = [1, 2, 1, 2, 1, 2, 5, 7, 8, 9, 7, 8, 9, 0, 1, 2];
  const cands = findCandidates(seq);
  expect(cands[0]).toEqual({ unit: [1, 2], count: 4 }); // coverage 8
  expect(cands[1]).toEqual({ unit: [7, 8, 9], count: 2 }); // coverage 6
});

test("returns empty for a sequence with no full repeats", () => {
  expect(findCandidates([9, 1, 7, 3, 0, 4])).toEqual([]);
});

// --- extractPatterns (jev judges each candidate) ---

function queuedFetch(bodies: unknown[]): typeof fetch {
  const queue = [...bodies];
  return (async () => {
    const body = queue.shift();
    if (body === undefined) throw new Error("mock queue empty — judged too many candidates");
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

const noul = (p: number) => ({ answers: { answer: { type: "noul", noul: p } } });

const TWO_PATTERN_SEQ = [1, 2, 1, 2, 1, 2, 5, 7, 8, 9, 7, 8, 9, 0, 1, 2];

test("accepts the candidates jev confirms and rejects the rest", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  // Candidates arrive ranked: [1,2], [7,8,9], then the [2,1] phase-echo.
  const script = queuedFetch([noul(0.9), noul(0.85), noul(0.2)]);
  expect(await extractPatterns(TWO_PATTERN_SEQ, 100, script)).toEqual({
    patterns: [
      { unit: [1, 2], count: 4 },
      { unit: [7, 8, 9], count: 2 },
    ],
    tries: 3,
    budgetExhausted: false,
  });
});

test("stops at the budget ceiling and flags it", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const script = queuedFetch([noul(0.9), noul(0.85)]);
  const res = await extractPatterns(TWO_PATTERN_SEQ, 2, script);
  expect(res).toEqual({
    patterns: [
      { unit: [1, 2], count: 4 },
      { unit: [7, 8, 9], count: 2 },
    ],
    tries: 2,
    budgetExhausted: true,
  });
});

test("returns the Error when a judgment fails", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const broken = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  expect(await extractPatterns(TWO_PATTERN_SEQ, 100, broken)).toBeInstanceOf(Error);
});

test("no candidates means no jev calls and an empty result", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const script = queuedFetch([]); // any call would throw "queue empty"
  expect(await extractPatterns([9, 1, 7, 3, 0, 4], 100, script)).toEqual({
    patterns: [],
    tries: 0,
    budgetExhausted: false,
  });
});
