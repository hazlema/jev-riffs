const $ = (id) => document.getElementById(id);
const canvas = $("roll");
const ctx = canvas.getContext("2d");

let midiBytes = null; // the raw file, resent to the api as needed
let parsed = null; //    { tracks, suggested }
let melody = null; //    [[tick,note],...] from the last rip
let motifs = [];
let active = -1; //      selected motif index

const status = (m) => ($("status").textContent = m);

// --- piano roll ---

function draw() {
  ctx.fillStyle = "#10142a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!parsed) return;

  const trackIdx = Number($("track").value);
  const all = parsed.tracks.flatMap((t) => t.notes);
  if (all.length === 0) return;
  // scale time to the CHOSEN track's window — a late harp flourish must not
  // crush the melody into the left edge
  const chosen = parsed.tracks[trackIdx];
  const base = chosen.notes.length ? chosen.notes : all;
  const t0 = Math.min(...base.map((n) => n[0]));
  const t1 = Math.max(...base.map((n) => n[0])) || t0 + 1;
  const inWindow = (tick) => tick >= t0 && tick <= t1;
  const lo = Math.min(...all.map((n) => n[1])) - 2;
  const hi = Math.max(...all.map((n) => n[1])) + 2;
  const x = (tick) => ((tick - t0) / (t1 - t0 || 1)) * (canvas.width - 20) + 10;
  const y = (note) => canvas.height - ((note - lo) / (hi - lo)) * (canvas.height - 20) - 10;
  const w = Math.max(2.5, ((canvas.width - 20) / (t1 - t0 || 1)) * 120);

  // every other track: faint context
  for (const t of parsed.tracks) {
    if (t.index === trackIdx) continue;
    ctx.fillStyle = "rgba(139,144,173,0.14)";
    for (const [tick, note] of t.notes) if (inWindow(tick)) ctx.fillRect(x(tick), y(note), w, 3);
  }
  // chosen track: bright
  ctx.fillStyle = "#4cc9b0";
  for (const [tick, note] of chosen.notes) ctx.fillRect(x(tick), y(note), w, 3.5);

  // motif highlighting over the ripped melody
  if (melody && active >= 0) {
    const spans = motifs[active].spans;
    ctx.fillStyle = "#e8b64c";
    for (const [a, b] of spans) {
      for (let i = a; i <= b && i < melody.length; i++) {
        const [tick, note] = melody[i];
        ctx.fillRect(x(tick) - 1, y(note) - 1.5, w + 2, 6);
      }
    }
  }
}

// --- playback: synthesize a motif's first occurrence with web audio ---

let audio = null; //  AudioContext, created on first click
let playing = []; //  scheduled nodes, stopped when a new motif plays

function stopPlayback() {
  for (const n of playing) {
    try { n.stop(); } catch {}
  }
  playing = [];
}

// The motif's full section as relative-time synth notes: start at the first
// occurrence and chain through later ones while the gap stays small, so the
// in-between material (the rest of the passage) plays too — not just the
// matched notes.
function segmentOf(m) {
  const secPerTick = parsed.timing.tempoUs / 1e6 / parsed.timing.division;
  let [a, b] = m.spans[0];
  for (let k = 1; k < m.spans.length; k++) {
    const [s, e] = m.spans[k];
    if (s - b <= m.unit.length * 2) b = e;
    else break;
  }
  const seg = melody.slice(a, Math.min(b + 1, melody.length));
  const t0 = seg[0][0];
  return seg.map(([tick, note], i) => {
    const next = seg[i + 1];
    return {
      start: (tick - t0) * secPerTick,
      dur: Math.min(Math.max(next ? (next[0] - tick) * secPerTick : 0.4, 0.12), 0.8),
      freq: 440 * Math.pow(2, (note - 69) / 12),
    };
  });
}

// one scheduler for both the speakers (AudioContext) and .wav rendering
// (OfflineAudioContext)
function scheduleInto(ctx, notes, at) {
  const nodes = [];
  for (const n of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = n.freq;
    const s = at + n.start;
    gain.gain.setValueAtTime(0, s);
    gain.gain.linearRampToValueAtTime(0.25, s + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, s + n.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(s);
    osc.stop(s + n.dur + 0.05);
    nodes.push(osc);
  }
  return nodes;
}

function playMotif(m) {
  if (!melody || !parsed?.timing) return;
  audio ??= new (window.AudioContext || window.webkitAudioContext)();
  stopPlayback();
  playing = scheduleInto(audio, segmentOf(m), audio.currentTime + 0.05);
}

async function motifWav(m) {
  const notes = segmentOf(m);
  const total = Math.max(...notes.map((n) => n.start + n.dur)) + 0.35;
  const sr = 44100;
  const off = new OfflineAudioContext(1, Math.ceil(total * sr), sr);
  scheduleInto(off, notes, 0.05);
  const buf = await off.startRendering();
  const pcm = buf.getChannelData(0);
  const wav = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(wav);
  const ws = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  ws(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); ws(8, "WAVE");
  ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, "data"); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++)
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([wav], { type: "audio/wav" });
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- motif cards ---

const LEVELS = ["INCIDENTAL", "FIGURE", "PHRASE", "SIGNATURE"];

function renderMotifs() {
  const box = $("motifs");
  box.innerHTML = "";
  motifs.forEach((m, i) => {
    const lvl = Math.min(3, Math.max(0, Math.round(m.significance)));
    const el = document.createElement("div");
    el.className = "motif" + (i === active ? " active" : "");
    el.innerHTML =
      `<span class="badge l${lvl}">${LEVELS[lvl]} ${m.significance.toFixed(2)}</span>` +
      `<div class="preview">${m.preview}</div>` +
      `<div class="unit">[${m.unit.join(",")}]</div>` +
      `<div class="meta">×${m.count} occurrences · ♪ click to play</div>` +
      `<button class="save">save .wav</button>`;
    el.onclick = () => {
      active = active === i ? -1 : i;
      renderMotifs();
      draw();
      if (active === i) playMotif(m);
      else stopPlayback();
    };
    el.querySelector(".save").onclick = async (e) => {
      e.stopPropagation();
      download(await motifWav(m), `motif-${i + 1}-${LEVELS[Math.min(3, Math.max(0, Math.round(m.significance)))].toLowerCase()}.wav`);
    };
    box.appendChild(el);
  });
}

// --- wiring ---

async function loadBytes(bytes, label) {
  midiBytes = bytes;
  melody = null;
  motifs = [];
  active = -1;
  status(`parsing ${label}…`);
  const res = await fetch("/api/parse", { method: "POST", body: bytes });
  const json = await res.json();
  if (json.error) return status(`parse failed: ${json.error}`);
  parsed = json;
  const sel = $("track");
  sel.innerHTML = "";
  for (const t of json.tracks) {
    if (t.noteCount === 0) continue;
    const o = document.createElement("option");
    o.value = t.index;
    o.textContent = `#${t.index} ${t.name || "(unnamed)"} — ${t.noteCount} notes`;
    if (t.index === json.suggested) o.selected = true;
    sel.appendChild(o);
  }
  sel.disabled = false;
  $("rip").disabled = false;
  renderMotifs();
  draw();
  status(`${label} loaded — pick a track and rip`);
}

$("demo").onclick = async () => {
  const res = await fetch("/demo.mid");
  loadBytes(await res.arrayBuffer(), "Swan Lake");
};

$("file").onchange = async (e) => {
  const f = e.target.files[0];
  if (f) loadBytes(await f.arrayBuffer(), f.name);
};

$("track").onchange = () => {
  melody = null;
  motifs = [];
  active = -1;
  renderMotifs();
  draw();
};

$("rip").onclick = async () => {
  const track = $("track").value;
  const minNotes = Number($("minnotes").value) || 5;
  $("rip").disabled = true;
  status("ripping… (jev is judging)");
  try {
    const res = await fetch(`/api/rip?track=${track}&minNotes=${minNotes}`, {
      method: "POST",
      body: midiBytes,
    });
    const json = await res.json();
    if (json.error) return status(`rip failed: ${json.error}`);
    melody = json.melody;
    motifs = json.motifs;
    active = motifs.length ? 0 : -1; // auto-select the top motif
    renderMotifs();
    draw();
    $("save").disabled = motifs.length === 0;
    status(`${motifs.length} motifs, ${json.tries} jev calls${json.budgetExhausted ? " (budget hit)" : ""}`);
  } finally {
    $("rip").disabled = false;
  }
};

$("save").onclick = () => {
  const out = {
    track: Number($("track").value),
    minNotes: Number($("minnotes").value) || 5,
    timing: parsed?.timing,
    motifs,
  };
  download(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }), "jev-riffs-motifs.json");
};

draw();
