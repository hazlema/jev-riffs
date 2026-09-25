# jev-riffs

A music pattern ripper: tokenize songs into small-alphabet symbol strings, then
find their repeating structure — riffs, hooks, choruses — using the miner+judge
pattern extractor from [jev-patterns](https://github.com/hazlema/jev-patterns).

The idea: melody is a string over a tiny alphabet (12 pitch classes, or the
intervals between notes). Code mines candidate repeating units mechanically;
[Jev](https://typesafe.ai) makes one semantic judgment per candidate — is this
a genuine motif, an ornamented variation, or coincidence?

Status: fresh. First spike is MIDI → interval tokens → `extractPatterns`
(MIDI sidesteps FFT/tempo work — it already *is* the tokens). Audio
tokenization (mid-band FFT, beat-synced sampling) comes after the concept
proves out.

## Run

```sh
# needs bun (https://bun.sh); no dependencies
cp .env.example .env   # add your TYPESAFE_API_KEY
bun test               # all mocked, no API calls
bun run patterns       # multi-pattern extraction demo on number sequences
```

`src/jev.ts` (query builder / sender / parser), `src/jev-client.ts`
(transport), and `src/patterns.ts` (candidate miner + Jev judge) are carried
over from jev-patterns; see that repo's README for the research story behind
the design.
