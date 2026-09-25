# The jev library

`src/jev.ts` + `src/jev-client.ts` — a ~200-line wrapper that makes
[Jev](https://typesafe.ai) (TypeSafe's System One model) feel like a language
primitive: build a typed query, send it, branch on the result. Originally
published in [jev-patterns](https://github.com/hazlema/jev-patterns); this
copy is ahead of that repo by `parseAnswers` (batched multi-question
responses), which jev-riffs needed and upstream hasn't absorbed yet.

```ts
import { jev, QueryType } from "./src/jev";

const r = await jev.send(
  jev.create(QueryType.choice, {
    prompt: "Which team should handle this ticket?",
    choices: { billing: "payments, refunds", technical: "bugs, outages" },
    state: { ticket: "I was charged twice for the same month." },
  })
);

if (r instanceof Error) retry(r);   // network/auth/timeout — as a value
else if (r === null) punt();        // response held no answer
else r.value;                       // "billing" — the winner, any query type
```

## Query builder — `jev.create(type, spec)`

Returns the complete wire-ready body `{ model, state, questions }` with the
single question keyed `answer`. `QueryType` values are the wire names, so the
enum drops straight into the JSON:

```ts
enum QueryType { question = "noul", choice = "choice", score = "score" }
```

| Type | Spec | Wire criteria |
| --- | --- | --- |
| `question` | `{ prompt, state?, criteria? }` | optional `{ true, false }` definitions |
| `choice` | `{ prompt, state?, choices }` | `string[]` → `{name: null}` (self-explanatory) or a `name → description` record; descriptions may be strings, rich objects (`{what, not_for, examples}`), or null |
| `score` | `{ prompt, state?, levels }` | ordered `string[]`, low → high, 2–10 entries (API limit) |

`prompt` may be a string, object, or array (the API accepts structured
instructions — useful for `{question, rule}` pairs). Malformed specs throw
immediately: bad input is a programming error; only runtime trouble becomes
an `Error` value.

Field notes learned live, enforced here:

- the API **422s on `state: null`** — state is required; `create` defaults it
  to `""` (the documented "no text" form);
- choice criteria are name→description maps, `null` when the name speaks for
  itself;
- question IDs are for code only, never shown to the model — hence the fixed
  `answer` key.

## Transport — `jev.send(body)` and `postSystemOne`

`send(body, fetchImpl?)` → `JevResult | null | Error`. Never throws: the
result, `null` for an empty-but-OK response, or the `Error` as a value —
branch with `instanceof`, no try/catch at call sites. Defaults
`model: "jev-latest"` only when the body doesn't carry one.

`postSystemOne(body, fetchImpl?, timeoutMs?)` (`src/jev-client.ts`) is the
raw layer: body in verbatim, parsed JSON out, throws on failure. It owns:

- 30s `AbortSignal.timeout` per attempt (a stalled keep-alive once froze a
  live app for good — never fetch without one);
- 2 attempts with 2s/4s backoff on 429/529;
- fail-fast `FatalAuthError` on 401/403 (retrying bad credentials is noise).

`fetchImpl` injection is how every test in this repo runs offline — queued
mock responses, zero API calls.

## Result — `JevResult`

Uniform across all three query types:

```ts
interface JevResult {
  type: "noul" | "choice" | "score";
  probabilities: Record<string, number>; // noul exposed as { true, false }
  confidence?: number;                   // choice/score
  legend?: Record<string, string>;       // score: level number → description
  position?: number;                     // score: probability-weighted 0..n
  first: string;                         // likeliest name
  last: string;                          // least likely name
  usage?: { input_tokens: number; output_tokens: number };
  readonly value: string;                // getter — whoever won (=== first)
  readonly max: string;                  // getter — === first
  readonly min: string;                  // getter — === last
}
```

Design choices worth knowing:

- **`value` is always the winner's name** — `"true"`/`"false"` for nouls,
  the option for choices, the level description for scores. The raw numbers
  survive: noul probability in `probabilities.true`, score's weighted mean
  in `position`.
- Nouls are exposed as a two-entry distribution so all three types rank the
  same way; `first`/`last` (and the `max`/`min` getters) work everywhere.
- The getters are enumerable, so `JSON.stringify` shows them — dumps read
  the way humans expect.

## Parsing — `jev.parse` and `jev.parseAnswers`

- `parse(raw)` → `JevResult | null` — reads the single `answers.answer`.
- `parseAnswers(raw)` → `Record<string, JevResult>` — for **batched**
  requests: several questions over one state in a single POST (they run in
  parallel server-side and cannot see each other's answers). Every answer is
  normalized identically, keyed as sent; `usage` (which the API reports once
  per request) is attached to each result.

Batching is the single biggest operational lever in this codebase: rip()
sends all candidate judgments as one request per chunk of 10. Under API
latency wobble, 15 sequential calls degraded to 2+ minutes; the batch runs
in ~600ms and uploads the (identical) state once. If your questions are
independent and share state, batch them — the docs say so, and now so does
our latency graph.

## Wire format reference

Request (all three fields required):

```json
{
  "state": "text or structured data",
  "model": "jev-latest",
  "questions": {
    "answer": { "type": "noul|choice|score", "instructions": "...", "criteria": "..." }
  }
}
```

Response answers by type (live-captured shapes):

```json
{ "type": "noul",   "noul": 0.95 }
{ "type": "choice", "choice": "attack", "confidence": 0.25,
  "probabilities": { "attack": 0.5, "flee": 0.31, "negotiate": 0.19 } }
{ "type": "score",  "score": 1.38, "confidence": 0.42,
  "legend": { "0": "...", "1": "...", "2": "..." },
  "probabilities": { "0": 0, "1": 0.62, "2": 0.38 } }
```

Plus a top-level `model` (the resolved version, e.g. `jev-1.13.0`) and
`usage: { input_tokens, output_tokens }` per request.
