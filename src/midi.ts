// Minimal MIDI reading for the ripper: note-on events per track, melody
// selection, and interval tokenization. Durations, tempo, and controllers
// are deliberately ignored — the ripper only needs pitch order.

export interface NoteOn {
  tick: number;
  note: number;
  channel: number;
}

export interface MidiTrack {
  name: string;
  notes: NoteOn[];
}

export function parseMidi(data: ArrayBuffer | Uint8Array): MidiTrack[] {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const str = (n: number) => {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(o + i));
    o += n;
    return s;
  };
  if (v.byteLength < 8 || str(4) !== "MThd") throw new Error("not a midi file");
  const hlen = v.getUint32(o);
  o += 4 + hlen; // header body (format/ntrks/division) isn't needed
  const tracks: MidiTrack[] = [];
  while (o + 8 <= v.byteLength) {
    if (str(4) !== "MTrk") break;
    const len = v.getUint32(o);
    o += 4;
    const end = o + len;
    let tick = 0;
    let running = 0;
    let name = "";
    const notes: NoteOn[] = [];
    const vlq = () => {
      let x = 0, b;
      do {
        b = v.getUint8(o++);
        x = (x << 7) | (b & 0x7f);
      } while (b & 0x80);
      return x;
    };
    while (o < end) {
      tick += vlq();
      let status = v.getUint8(o);
      if (status & 0x80) {
        o++;
        if (status < 0xf0) running = status;
      } else status = running;
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

// Playback timing: ticks-per-quarter from the header and the first tempo
// meta event (µs per quarter). seconds-per-tick = tempoUs / 1e6 / division.
export function parseTiming(data: ArrayBuffer | Uint8Array): { division: number; tempoUs: number } {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let division = 480;
  if (v.byteLength >= 14) {
    const d = v.getUint16(12);
    if (!(d & 0x8000)) division = d; // SMPTE division: keep the 480 fallback
  }
  let o = 8 + v.getUint32(4); // past MThd
  let tempoUs = 500000;
  outer: while (o + 8 <= v.byteLength) {
    let s = "";
    for (let i = 0; i < 4; i++) s += String.fromCharCode(v.getUint8(o + i));
    o += 4;
    if (s !== "MTrk") break;
    const len = v.getUint32(o);
    o += 4;
    const end = o + len;
    let running = 0;
    const vlq = () => {
      let x = 0, b;
      do {
        b = v.getUint8(o++);
        x = (x << 7) | (b & 0x7f);
      } while (b & 0x80);
      return x;
    };
    while (o < end) {
      vlq(); // delta
      let status = v.getUint8(o);
      if (status & 0x80) {
        o++;
        if (status < 0xf0) running = status;
      } else status = running;
      if (status === 0xff) {
        const type = v.getUint8(o++);
        const mlen = vlq();
        if (type === 0x51 && mlen === 3) {
          tempoUs = (v.getUint8(o) << 16) | (v.getUint8(o + 1) << 8) | v.getUint8(o + 2);
          break outer;
        }
        o += mlen;
      } else if (status === 0xf0 || status === 0xf7) {
        o += vlq();
      } else {
        const kind = status & 0xf0;
        o += kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      }
    }
    o = end;
  }
  return { division, tempoUs };
}

// Melody line: the chosen track's notes, monophonized by keeping the highest
// note of each same-tick cluster. Default choice = densest track after
// dropping drum-channel notes; an explicit pick takes the track as-is.
export function melodyOf(tracks: MidiTrack[], pick?: number): NoteOn[] {
  let notes: NoteOn[];
  if (pick !== undefined) {
    notes = tracks[pick]?.notes ?? [];
  } else {
    const tuned = tracks
      .map((t) => t.notes.filter((n) => n.channel !== 9))
      .filter((ns) => ns.length > 0)
      .sort((a, b) => b.length - a.length);
    notes = tuned[0] ?? [];
  }
  if (notes.length === 0) throw new Error("no notes in the chosen track");
  const byTick = new Map<number, number>();
  for (const n of notes) byTick.set(n.tick, Math.max(byTick.get(n.tick) ?? 0, n.note));
  return [...byTick.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tick, note]) => ({ tick, note, channel: notes[0].channel }));
}

export function toIntervals(notes: number[]): number[] {
  return notes.slice(1).map((n, i) => n - notes[i]);
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function noteName(n: number): string {
  return `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}
