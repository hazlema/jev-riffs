import { test, expect } from "bun:test";
import { callSystemOne, type NoulQuestion } from "./jev-client";

const QS: Record<string, NoulQuestion> = {
  done: { type: "noul", instructions: "Is it done?" },
};

function fakeFetch(status: number, body: unknown, calls: number[] = []): typeof fetch {
  return (async (_url: any, _init: any) => {
    calls.push(status);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

test("returns answers and latency on success", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const res = await callSystemOne(
    { narrative: "x" },
    QS,
    fakeFetch(200, { answers: { done: { type: "noul", noul: 0.9 } } })
  );
  expect(res.answers.done.noul).toBe(0.9);
  expect(res.latencyMs).toBeGreaterThanOrEqual(0);
});

test("throws when TYPESAFE_API_KEY missing", async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  await expect(callSystemOne({}, QS, fakeFetch(200, {}))).rejects.toThrow(/TYPESAFE_API_KEY/);
  if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = saved;
});

test("fails fast on 401 without retry", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const calls: number[] = [];
  await expect(
    callSystemOne({}, QS, fakeFetch(401, { error: "bad key" }, calls))
  ).rejects.toThrow(/401/);
  expect(calls.length).toBe(1);
});

test("retries once on 500 then succeeds", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  let n = 0;
  const impl = (async () => {
    n++;
    if (n === 1) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ answers: { done: { type: "noul", noul: 0.5 } } }), { status: 200 });
  }) as typeof fetch;
  const res = await callSystemOne({}, QS, impl);
  expect(res.answers.done.noul).toBe(0.5);
  expect(n).toBe(2);
});

test("aborts a stalled request after timeoutMs and retries, then throws", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  let calls = 0;
  // A fetch that never responds but honors the abort signal.
  const stalled = ((_url: any, init: any) => {
    calls++;
    return new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  }) as typeof fetch;
  const start = performance.now();
  await expect(callSystemOne({}, QS, stalled, 50)).rejects.toThrow(/timed out|TimeoutError/i);
  expect(calls).toBe(2); // stalled attempt aborted, retried once, aborted again
  expect(performance.now() - start).toBeLessThan(2000); // bounded, not hung
});
