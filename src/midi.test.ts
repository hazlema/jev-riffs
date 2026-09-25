import { test, expect } from "bun:test";
import { parseMidi, melodyOf, toIntervals, noteName } from "./midi";

// --- fixture builder: hand-assembled MIDI bytes ---

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function track(...events: number[][]): number[] {
  const body = [...events.flat(), 0x00, 0xff, 0x2f, 0x00]; // + end-of-track
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
}

function midi(...tracks: number[][]): Uint8Array {
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, ...u32(6), 0x00, 0x01, 0x00, tracks.length, 0x01, 0xe0,
    ...tracks.flat(),
  ]);
}

// --- parseMidi ---

test("parses note-ons with accumulated ticks, ignores note-offs", () => {
  const bytes = midi(
    track(
      [0x00, 0x90, 60, 64], // tick 0: C4 on
      [0x81, 0x60, 0x80, 60, 0], // +224: C4 off (vlq 0x81 0x60 = 224)
      [0x00, 0x90, 64, 64] // tick 224: E4 on
    )
  );
  const [t] = parseMidi(bytes);
  expect(t.notes).toEqual([
    { tick: 0, note: 60, channel: 0 },
    { tick: 224, note: 64, channel: 0 },
  ]);
});

test("handles running status and velocity-0 note-offs", () => {
  const bytes = midi(
    track(
      [0x00, 0x90, 60, 64], // C4 on
      [0x0a, 62, 64], // +10, running status: D4 on
      [0x0a, 62, 0] // +10, velocity 0 = off, not a note
    )
  );
  const [t] = parseMidi(bytes);
  expect(t.notes.map((n) => n.note)).toEqual([60, 62]);
});

test("reads the track-name meta event", () => {
  const bytes = midi(track([0x00, 0xff, 0x03, 4, 0x4f, 0x42, 0x4f, 0x45])); // "OBOE"
  expect(parseMidi(bytes)[0].name).toBe("OBOE");
});

test("throws on non-midi bytes", () => {
  expect(() => parseMidi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/midi/i);
});

// --- melodyOf ---

test("keeps the highest note of a same-tick chord", () => {
  const bytes = midi(
    track([0x00, 0x90, 60, 64], [0x00, 0x90, 64, 64], [0x0a, 0x90, 62, 64]) // chord C+E, then D
  );
  expect(melodyOf(parseMidi(bytes)).map((n) => n.note)).toEqual([64, 62]);
});

test("picks the densest non-drum track by default, honors pick override", () => {
  const drums = track([0x00, 0x99, 35, 64], [0x0a, 0x99, 38, 64], [0x0a, 0x99, 35, 64]); // ch9
  const tune = track([0x00, 0x90, 60, 64], [0x0a, 0x90, 62, 64]);
  const tracks = parseMidi(midi(drums, tune));
  expect(melodyOf(tracks).map((n) => n.note)).toEqual([60, 62]); // drums outnumber but are skipped
  expect(melodyOf(tracks, 0).map((n) => n.note)).toEqual([35, 38, 35]); // explicit pick wins
});

// --- tokens ---

test("toIntervals and noteName", () => {
  expect(toIntervals([60, 64, 62])).toEqual([4, -2]);
  expect(noteName(60)).toBe("C4");
  expect(noteName(69)).toBe("A4");
  expect(noteName(61)).toBe("C#4");
});
