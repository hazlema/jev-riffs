import { test, expect } from "bun:test";
import { jev, QueryType } from "./jev";

function fakeFetch(status: number, body: unknown, sent: unknown[] = []): typeof fetch {
  return (async (_url: any, init: any) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

// --- create ---

test("create question builds a complete one-noul query", () => {
  expect(jev.create(QueryType.question, { prompt: "Is it done?" })).toEqual({
    model: "jev-latest",
    state: "",
    questions: { answer: { type: "noul", instructions: "Is it done?" } },
  });
});

// The API 422s on state: null ("Field required") — seen live 2026-09-23, so
// stateless queries must default to an empty string, not null.
test("create never emits a null state", () => {
  const body = jev.create(QueryType.choice, { prompt: "p", choices: ["a", "b"] }) as any;
  expect(body.state).toBe("");
});

test("create question passes optional true/false criteria through", () => {
  const body = jev.create(QueryType.question, {
    prompt: "Urgent?",
    criteria: { true: "time-sensitive", false: "no urgency" },
  }) as any;
  expect(body.questions.answer.criteria).toEqual({ true: "time-sensitive", false: "no urgency" });
});

test("create passes state through", () => {
  const body = jev.create(QueryType.question, { prompt: "p", state: { hp: 3 } }) as any;
  expect(body.state).toEqual({ hp: 3 });
});

test("create allows object instructions", () => {
  const body = jev.create(QueryType.question, {
    prompt: { question: "Which?", focus: "tone" },
  }) as any;
  expect(body.questions.answer.instructions).toEqual({ question: "Which?", focus: "tone" });
});

test("create choice maps a bare choices array to self-explanatory options", () => {
  expect(jev.create(QueryType.choice, { prompt: "Pick one", choices: ["run", "hide"] })).toEqual({
    model: "jev-latest",
    state: "",
    questions: {
      answer: { type: "choice", instructions: "Pick one", criteria: { run: null, hide: null } },
    },
  });
});

test("create choice passes a name-to-description record through", () => {
  const body = jev.create(QueryType.choice, {
    prompt: "Which team?",
    choices: { billing: "payments, refunds", technical: { what: "bugs", examples: ["500s"] } },
  }) as any;
  expect(body.questions.answer.criteria).toEqual({
    billing: "payments, refunds",
    technical: { what: "bugs", examples: ["500s"] },
  });
});

test("create score passes levels through as ordered criteria", () => {
  expect(jev.create(QueryType.score, { prompt: "How bad?", levels: ["fine", "bad", "dire"] })).toEqual({
    model: "jev-latest",
    state: "",
    questions: {
      answer: { type: "score", instructions: "How bad?", criteria: ["fine", "bad", "dire"] },
    },
  });
});

test("create throws on malformed input", () => {
  expect(() => jev.create(QueryType.question, {} as any)).toThrow(/prompt/);
  expect(() => jev.create(QueryType.question, { prompt: "" } as any)).toThrow(/prompt/);
  expect(() => jev.create(QueryType.choice, { prompt: "p", choices: [] } as any)).toThrow(/choices/);
  expect(() => jev.create(QueryType.choice, { prompt: "p" } as any)).toThrow(/choices/);
  expect(() => jev.create(QueryType.score, { prompt: "p", levels: ["only one"] } as any)).toThrow(/levels/);
  expect(() =>
    jev.create(QueryType.score, { prompt: "p", levels: Array(11).fill("x") } as any)
  ).toThrow(/levels/);
});

// --- parse ---
// Raw shapes below are taken from live jev-1.13.0 responses (2026-09-23).

test("parse noul answer: winner is true/false, probability kept", () => {
  const raw = {
    model: "jev-1.13.0",
    answers: { answer: { type: "noul", noul: 0.95 } },
    usage: { input_tokens: 314, output_tokens: 20 },
  };
  expect(jev.parse(raw)).toEqual({
    type: "noul",
    probabilities: { true: 0.95, false: 0.05 },
    first: "true",
    last: "false",
    value: "true",
    max: "true",
    min: "false",
    usage: { input_tokens: 314, output_tokens: 20 },
  });
});

test("parse choice answer: value is the winning option", () => {
  const raw = {
    model: "jev-1.13.0",
    answers: {
      answer: {
        type: "choice",
        choice: "attack",
        confidence: 0.25,
        probabilities: { attack: 0.5, flee: 0.31, negotiate: 0.19 },
      },
    },
    usage: { input_tokens: 299, output_tokens: 41 },
  };
  expect(jev.parse(raw)).toEqual({
    type: "choice",
    confidence: 0.25,
    probabilities: { attack: 0.5, flee: 0.31, negotiate: 0.19 },
    first: "attack",
    last: "negotiate",
    value: "attack",
    max: "attack",
    min: "negotiate",
    usage: { input_tokens: 299, output_tokens: 41 },
  });
});

test("parse score answer: value is the weighted position, legend kept", () => {
  const raw = {
    model: "jev-1.13.0",
    answers: {
      answer: {
        type: "score",
        score: 1.37,
        confidence: 0.44,
        legend: { "0": "cosmetic", "1": "workaround", "2": "blocking" },
        probabilities: { "0": 0, "1": 0.63, "2": 0.37 },
      },
    },
    usage: { input_tokens: 331, output_tokens: 17 },
  };
  expect(jev.parse(raw)).toEqual({
    type: "score",
    confidence: 0.44,
    legend: { "0": "cosmetic", "1": "workaround", "2": "blocking" },
    probabilities: { "0": 0, "1": 0.63, "2": 0.37 },
    position: 1.37, // the weighted mean lives here now; value is the winner
    first: "workaround", // legend name of the likeliest level
    last: "cosmetic",
    value: "workaround",
    max: "workaround",
    min: "cosmetic",
    usage: { input_tokens: 331, output_tokens: 17 },
  });
});

test("parse returns null when there is no answers.answer", () => {
  expect(jev.parse(null)).toBeNull();
  expect(jev.parse({})).toBeNull();
  expect(jev.parse({ answers: {} })).toBeNull();
  expect(jev.parse("nonsense")).toBeNull();
});

// --- send ---

test("send returns the parsed result", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const raw = { answers: { answer: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 12, output_tokens: 3 } };
  const res = await jev.send(jev.create(QueryType.question, { prompt: "p" }), fakeFetch(200, raw));
  expect(res).toEqual({
    type: "noul",
    probabilities: { true: 0.9, false: 0.1 },
    first: "true",
    last: "false",
    value: "true",
    max: "true",
    min: "false",
    usage: { input_tokens: 12, output_tokens: 3 },
  });
});

test("send defaults a missing model but keeps a caller-supplied one", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const sent: any[] = [];
  await jev.send({ state: null, questions: {} }, fakeFetch(200, {}, sent));
  await jev.send({ model: "jev-2", questions: {} }, fakeFetch(200, {}, sent));
  expect(sent[0].model).toBe("jev-latest");
  expect(sent[1].model).toBe("jev-2");
});

test("send returns null when the response body is empty json", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const res = await jev.send(jev.create(QueryType.question, { prompt: "p" }), fakeFetch(200, null));
  expect(res).toBeNull();
});

test("send returns an Error instead of throwing on http failure", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const res = await jev.send(jev.create(QueryType.question, { prompt: "p" }), fakeFetch(500, "boom"));
  expect(res).toBeInstanceOf(Error);
});

test("send returns an Error instead of throwing on auth failure", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  const res = await jev.send(jev.create(QueryType.question, { prompt: "p" }), fakeFetch(401, "nope"));
  expect(res).toBeInstanceOf(Error);
  expect(String(res)).toMatch(/401/);
});

// --- parseAnswers (batched multi-question responses) ---

test("parseAnswers normalizes every answer in a batched response", () => {
  const raw = {
    model: "jev-1.13.0",
    answers: {
      q0: { type: "noul", noul: 0.9 },
      q1: {
        type: "choice",
        choice: "b",
        confidence: 0.8,
        probabilities: { a: 0.2, b: 0.8 },
      },
    },
    usage: { input_tokens: 50, output_tokens: 9 },
  };
  const all = jev.parseAnswers(raw);
  expect(Object.keys(all)).toEqual(["q0", "q1"]);
  expect(all.q0.value).toBe("true");
  expect(all.q0.probabilities).toEqual({ true: 0.9, false: 0.1 });
  expect(all.q1.value).toBe("b");
  expect(all.q1.usage).toEqual({ input_tokens: 50, output_tokens: 9 });
});

test("parseAnswers returns empty for junk", () => {
  expect(jev.parseAnswers(null)).toEqual({});
  expect(jev.parseAnswers({ answers: "x" })).toEqual({});
});
