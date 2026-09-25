// SPIKE (throwaway): does the miner+judge rip a real motif from real music?
// MIDI -> melody track -> interval tokens -> findCandidates -> jev judges.
// Run: bun spike/rip.ts [file.mid]

import { jev, QueryType } from "../src/jev";
import { findCandidates } from "../src/patterns";

// --- minimal MIDI parse: just note-on events per track ---

interface NoteOn {
  tick: number;
  note: number;
  channel: number;
}

function parseMidi(buf: ArrayBuffer): { name: string; notes: NoteOn[] }[] {
  const v = new DataView(buf);
  let o = 0;
  const str = (n: number) => {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(o + i));
    o += n;
    return s;
  };
  if (str(4) !== "MThd") throw new Error("not a midi file");
  const hlen = v.getUint32(o); o += 4;
  o += hlen; // skip format/ntrks/division — we take all tracks as-is
  const tracks: { name: string; notes: NoteOn[] }[] = [];
  while (o < v.byteLength - 8) {
    if (str(4) !== "MTrk") break;
    const len = v.getUint32(o); o += 4;
    const end = o + len;
    let tick = 0;
    let running = 0;
    let name = "";
    const notes: NoteOn[] = [];
    const vlq = () => {
      let x = 0, b;
      do { b = v.getUint8(o++); x = (x << 7) | (b & 0x7f); } while (b & 0x80);
      return x;
    };
    while (o < end) {
      tick += vlq();
      let status = v.getUint8(o);
      if (status & 0x80) { o++; if (status < 0xf0) running = status; }
      else status = running;
      if (status === 0xff) {
        const type = v.getUint8(o++);
        const mlen = vlq();
        if (type === 0x03) {
          let s = "";
          for (let i = 0; i < mlen; i++) s += String.fromCharCode(v.getUint8(o + i));
          name = s;
        }
        o += mlen;
      } else if (status === 0xf0 || status === 0xf7) {
        o += vlq();
      } else {
        const kind = status & 0xf0;
        const d1 = v.getUint8(o++);
        const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : v.getUint8(o++);
        if (kind === 0x90 && d2 > 0) notes.push({ tick, note: d1, channel: status & 0x0f });
      }
    }
    o = end;
    tracks.push({ name, notes });
  }
  return tracks;
}

// --- melody: densest non-drum track, highest note per tick cluster ---

function melodyOf(tracks: { name: string; notes: NoteOn[] }[], pick?: number): NoteOn[] {
  const tuned = tracks
    .map((t) => ({ ...t, notes: t.notes.filter((n) => n.channel !== 9) }))
    .filter((t) => t.notes.length > 0)
    .sort((a, b) => b.notes.length - a.notes.length);
  const best = pick !== undefined ? tracks[pick] : tuned[0];
  console.log(
    `tracks: ${tracks.map((t, i) => `#${i}"${t.name}"(${t.notes.length})`).join(" ")}\n` +
      `melody track: "${best.name}" with ${best.notes.length} note-ons`
  );
  const byTick = new Map<number, number>();
  for (const n of best.notes) byTick.set(n.tick, Math.max(byTick.get(n.tick) ?? 0, n.note));
  return [...byTick.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tick, note]) => ({ tick, note, channel: 0 }));
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (n: number) => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

// --- rip ---

const path = process.argv[2] ?? "media/swan-lake.mid";
const pick = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined;
const melody = melodyOf(parseMidi(await Bun.file(path).arrayBuffer()), pick);
const MAX = 150; // keep mining cheap; themes state themselves early and often
const notes = melody.slice(0, MAX).map((n) => n.note);
console.log(`\nfirst notes: ${notes.slice(0, 24).map(noteName).join(" ")}`);

const intervals = notes.slice(1).map((n, i) => n - notes[i]);
console.log(`interval tokens (${intervals.length}): ${intervals.slice(0, 24).join(",")} ...`);

const candidates = findCandidates(intervals);
console.log(`\nmined ${candidates.length} candidate(s):`);
for (const c of candidates) console.log(`  [${c.unit.join(",")}] ×${c.count} (len ${c.unit.length})`);

const rule =
  "A genuine musical motif appears at least twice in full within `intervals` and reflects deliberate melodic repetition. Coincidental overlaps of unrelated passages are not a motif.";

const accepted: { unit: number[]; count: number; p: number }[] = [];
let tries = 0;
for (const c of candidates) {
  if (tries >= 100) break;
  tries++;
  const r = await jev.send(
    jev.create(QueryType.question, {
      prompt: {
        question:
          "`intervals` is a melody encoded as semitone steps between consecutive notes. Is `candidate` a genuine repeating musical motif within `intervals`, rather than a coincidental arrangement?",
        rule,
      },
      state: { intervals, candidate: c.unit },
    })
  );
  if (r instanceof Error || r === null) {
    console.log(`  judge error on [${c.unit.join(",")}]: ${r instanceof Error ? r.message : "empty"}`);
    continue;
  }
  console.log(`  [${c.unit.join(",")}]×${c.count} -> ${r.value} (p ${r.probabilities.true})`);
  if (r.value === "true") accepted.push({ ...c, p: r.probabilities.true });
}

console.log(`\n=== motifs (${accepted.length}) ===`);
for (const m of accepted) {
  // show the motif as actual notes from its first occurrence
  let at = -1;
  for (let i = 0; i + m.unit.length <= intervals.length; i++) {
    if (m.unit.every((x, k) => intervals[i + k] === x)) { at = i; break; }
  }
  const run = at >= 0 ? notes.slice(at, at + m.unit.length + 1).map(noteName).join(" ") : "?";
  console.log(`[${m.unit.join(",")}] ×${m.count} p=${m.p}  e.g. ${run}`);
}
