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

test("drops rotation echoes, keeping the higher-coverage phase", () => {
  // [2,1] is [1,2] shifted; it must not survive as a separate candidate.
  const units = findCandidates([1, 2, 1, 2, 1, 2, 5, 7, 8, 9, 7, 8, 9, 0, 1, 2]).map((c) =>
    c.unit.join(",")
  );
  expect(units).toContain("1,2");
  expect(units).not.toContain("2,1");
});

test("drops a superstring that does not out-cover the unit it contains", () => {
  // The 42-number gauntlet: [7,3,8,2,4,1]×2 (cov 12) rides on [7,3,8,2,4]×3
  // (cov 15) — a noise-tail superstring, dropped.
  const seq = [6,1,0,5,9,7,3,8,2,4,1,1,6,0,8,7,3,8,2,4,5,0,3,2,9,6,9,0,7,3,8,2,4,1,7,0,4,4,2,8,6,5];
  expect(findCandidates(seq)).toEqual([{ unit: [7, 3, 8, 2, 4], count: 3 }]);
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
  // Candidates arrive ranked and deduped: [1,2], [7,8,9] — no [2,1] echo.
  const script = queuedFetch([noul(0.9), noul(0.2)]);
  expect(await extractPatterns(TWO_PATTERN_SEQ, 100, script)).toEqual({
    patterns: [{ unit: [1, 2], count: 4 }],
    tries: 2,
    budgetExhausted: false,
  });
});

test("stops at the budget ceiling and flags it", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const script = queuedFetch([noul(0.9)]);
  const res = await extractPatterns(TWO_PATTERN_SEQ, 1, script);
  expect(res).toEqual({
    patterns: [{ unit: [1, 2], count: 4 }],
    tries: 1,
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
