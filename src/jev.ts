// Doodads for quick Jev experiments: build a one-question query, send it raw.
//
//   const body = jev.create(QueryType.choice, { prompt: "Pick one", choices: ["run", "hide"] });
//   const res = await jev.send(body); // response json | null | Error — never throws
//
// create returns the complete formatted Jev JSON ({ model, state, questions }).
// Every query holds exactly one question, keyed `answer`, so processor fns
// always read `res.answers.answer`.

import { postSystemOne } from "./jev-client";

// Values are the wire type names the API speaks.
export enum QueryType {
  question = "noul",
  choice = "choice",
  score = "score",
}

// Per the docs, instructions may be a string, object, or array; a criteria
// description may be a string, a rich object, or null when the name says it all.
export type Prompt = string | object | unknown[];
export type ChoiceDescription = string | object | null;

export interface QuestionSpec {
  prompt: Prompt;
  state?: unknown;
  criteria?: { true: string; false: string }; // optional yes/no definitions
}

export interface ChoiceSpec {
  prompt: Prompt;
  state?: unknown;
  // Bare names (self-explanatory options) or name → description.
  choices: string[] | Record<string, ChoiceDescription>;
}

export interface ScoreSpec {
  prompt: Prompt;
  state?: unknown;
  levels: string[]; // ordered low → high, 2-10 entries (API limit)
}

export interface JevResult {
  type: "noul" | "choice" | "score";
  confidence?: number;
  // noul answers are exposed as a { true, false } distribution so every type
  // ranks the same way.
  probabilities: Record<string, number>;
  legend?: Record<string, string>;
  position?: number; // score only: the probability-weighted position
  first: string; // likeliest name — "true"/"false", option, or level
  last: string; // least likely name
  usage?: { input_tokens: number; output_tokens: number };
  // Human-friendly getters over first/last:
  readonly value: string; // whoever won (=== first)
  readonly max: string; // === first
  readonly min: string; // === last
}

export const jev = {
  create(t: QueryType, obj: QuestionSpec | ChoiceSpec | ScoreSpec): object {
    const prompt = obj?.prompt;
    if (prompt == null || (typeof prompt === "string" && prompt.length === 0)) {
      throw new Error("jev.create: obj.prompt (non-empty) is required");
    }
    const question: Record<string, unknown> = { type: t, instructions: prompt };
    if (t === QueryType.question) {
      const { criteria } = obj as QuestionSpec;
      if (criteria) question.criteria = criteria;
    } else if (t === QueryType.choice) {
      const { choices } = obj as ChoiceSpec;
      const criteria = Array.isArray(choices)
        ? Object.fromEntries(choices.map((c) => [c, null]))
        : choices;
      if (!criteria || typeof criteria !== "object" || Object.keys(criteria).length === 0) {
        throw new Error("jev.create: choice needs choices (non-empty array or name→description record)");
      }
      question.criteria = criteria;
    } else if (t === QueryType.score) {
      const { levels } = obj as ScoreSpec;
      if (!Array.isArray(levels) || levels.length < 2 || levels.length > 10) {
        throw new Error("jev.create: score needs 2-10 levels, ordered low to high");
      }
      question.criteria = levels;
    }
    // The API 422s on a null state (field is required); empty string is the
    // documented "no text" form.
    return { model: "jev-latest", state: obj.state ?? "", questions: { answer: question } };
  },

  // Raw response json in, branch-ready result out. Null when there is no
  // `answers.answer` to read.
  parse(raw: unknown): JevResult | null {
    const answer = (raw as any)?.answers?.answer;
    if (!answer || typeof answer !== "object") return null;
    const probabilities: Record<string, number> | undefined =
      answer.type === "noul" && typeof answer.noul === "number"
        ? { true: answer.noul, false: Math.round((1 - answer.noul) * 1e6) / 1e6 }
        : answer.probabilities;
    if (!probabilities || Object.keys(probabilities).length === 0) return null;
    // Score keys are level numbers; the legend turns them into names.
    const name = (k: string) => answer.legend?.[k] ?? k;
    const entries = Object.entries(probabilities) as [string, number][];
    const first = name(entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0]);
    const last = name(entries.reduce((a, b) => (b[1] < a[1] ? b : a))[0]);
    const usage = (raw as any).usage;
    return {
      type: answer.type,
      ...(answer.confidence !== undefined && { confidence: answer.confidence }),
      probabilities,
      ...(answer.legend && { legend: answer.legend }),
      ...(answer.type === "score" && { position: answer.score }),
      first,
      last,
      ...(usage && { usage }),
      get value() {
        return first;
      },
      get max() {
        return first;
      },
      get min() {
        return last;
      },
    };
  },

  async send(body: unknown, fetchImpl: typeof fetch = fetch): Promise<JevResult | null | Error> {
    try {
      const withModel =
        body !== null && typeof body === "object" && !("model" in body)
          ? { model: "jev-latest", ...body }
          : body;
      return jev.parse(await postSystemOne(withModel, fetchImpl));
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  },
};
