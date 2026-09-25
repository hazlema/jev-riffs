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

function playMotif(m) {
  if (!melody || !parsed?.timing) return;
  audio ??= new (window.AudioContext || window.webkitAudioContext)();
  stopPlayback();
  const secPerTick = parsed.timing.tempoUs / 1e6 / parsed.timing.division;
  const [a, b] = m.spans[0];
  const seg = melody.slice(a, Math.min(b + 1, melody.length));
  const t0 = seg[0][0];
  const now = audio.currentTime + 0.05;
  seg.forEach(([tick, note], i) => {
    const start = now + (tick - t0) * secPerTick;
    const next = seg[i + 1];
    const dur = Math.min(Math.max(next ? (next[0] - tick) * secPerTick : 0.4, 0.12), 0.8);
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "triangle";
    osc.frequency.value = 440 * Math.pow(2, (note - 69) / 12);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.25, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
    osc.connect(gain).connect(audio.destination);
    osc.start(start);
    osc.stop(start + dur + 0.05);
    playing.push(osc);
  });
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
      `<div class="meta">×${m.count} occurrences · ♪ click to play</div>`;
    el.onclick = () => {
      active = active === i ? -1 : i;
      renderMotifs();
      draw();
      if (active === i) playMotif(m);
      else stopPlayback();
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
  $("rip").disabled = true;
  status("ripping… (jev is judging)");
  try {
    const res = await fetch(`/api/rip?track=${track}`, { method: "POST", body: midiBytes });
    const json = await res.json();
    if (json.error) return status(`rip failed: ${json.error}`);
    melody = json.melody;
    motifs = json.motifs;
    active = motifs.length ? 0 : -1; // auto-select the top motif
    renderMotifs();
    draw();
    status(`${motifs.length} motifs, ${json.tries} jev calls${json.budgetExhausted ? " (budget hit)" : ""}`);
  } finally {
    $("rip").disabled = false;
  }
};

draw();
