# jev-riffs

A music pattern ripper: tokenize songs into small-alphabet symbol strings, then
find their repeating structure — riffs, hooks, choruses — using the miner+judge
pattern extractor from [jev-patterns](https://github.com/hazlema/jev-patterns).

The idea: melody is a string over a tiny alphabet (12 pitch classes, or the
intervals between notes). Code mines candidate repeating units mechanically;
[Jev](https://typesafe.ai) makes one semantic judgment per candidate — is this
a genuine motif, an ornamented variation, or coincidence?

Status: the concept is proven and the ripper is live. The MIDI spike pulled
Tchaikovsky's Swan Lake theme out of a 17-track orchestral file as its
top-confidence motif; the promoted pipeline grades every mined candidate on a
4-level significance scale (`incidental / figure / phrase / signature`) in a
single batched request. Audio tokenization (mid-band FFT, beat-synced
sampling) is the next frontier.

## Run

```sh
# needs bun (https://bun.sh); no dependencies
cp .env.example .env   # add your TYPESAFE_API_KEY
bun test               # all mocked, no API calls
bun server.ts          # web UI on http://localhost:4173
```

The web UI: load a `.mid` (or the bundled Swan Lake demo — fetch any MIDI to
`spike/swan.mid`), see the piano roll, pick a track, hit **Rip patterns**.
Motif cards come back ranked by significance; clicking one highlights every
occurrence on the roll. Auto-highlighting the top signature motif is the seed
of automatic melody selection.

## Pipeline

`src/midi.ts` (parse → melody → intervals) → `src/patterns.ts` (mine
candidate units in code: non-overlapping counts, shadow/rotation/superstring
dedupe) → `src/rip.ts` (one batched Jev request grades all candidates —
independent questions over the same state ride together, per the System One
docs; 15 sequential round trips took minutes under latency wobble, the batch
takes under a second).

`src/jev.ts` (query builder / sender / parser), `src/jev-client.ts`
(transport), and `src/patterns.ts` (candidate miner + Jev judge) are carried
over from jev-patterns; see that repo's README for the research story behind
the design.
