// jev-riffs web server: piano roll + live motif ripping.
// Run: bun server.ts   (PORT env respected; needs TYPESAFE_API_KEY for /api/rip)

import { join } from "node:path";
import { parseMidi, melodyOf, toIntervals, noteName } from "./src/midi";
import { rip } from "./src/rip";

const ROOT = import.meta.dir;

// bun only auto-loads .env from the cwd; when launched from elsewhere,
// pull the key from the repo's own .env so /api/rip still works.
if (!process.env.TYPESAFE_API_KEY) {
  try {
    const env = await Bun.file(join(ROOT, ".env")).text();
    const m = env.match(/^TYPESAFE_API_KEY=(.+)$/m);
    if (m) process.env.TYPESAFE_API_KEY = m[1].trim();
  } catch {}
}

async function file(rel: string, type: string): Promise<Response> {
  const f = Bun.file(join(ROOT, rel));
  return (await f.exists())
    ? new Response(f, { headers: { "Content-Type": type } })
    : new Response("not found", { status: 404 });
}

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p === "/") return file("web/index.html", "text/html; charset=utf-8");
  if (p === "/app.js") return file("web/app.js", "text/javascript; charset=utf-8");
  if (p === "/style.css") return file("web/style.css", "text/css; charset=utf-8");
  if (p === "/demo.mid") return file("spike/swan.mid", "audio/midi");

  if (p === "/api/parse" && req.method === "POST") {
    try {
      const tracks = parseMidi(await req.arrayBuffer());
      const tuned = tracks
        .map((t, index) => ({ index, name: t.name, noteCount: t.notes.filter((n) => n.channel !== 9).length }))
        .filter((t) => t.noteCount > 0);
      const suggested = tuned.reduce((a, b) => (b.noteCount > a.noteCount ? b : a), tuned[0]);
      return Response.json({
        tracks: tracks.map((t, index) => ({
          index,
          name: t.name,
          noteCount: t.notes.length,
          notes: t.notes.map((n) => [n.tick, n.note]),
        })),
        suggested: suggested?.index ?? 0,
      });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  if (p === "/api/rip" && req.method === "POST") {
    try {
      const track = Number(url.searchParams.get("track") ?? "-1");
      const cap = Number(url.searchParams.get("cap") ?? "150");
      const tracks = parseMidi(await req.arrayBuffer());
      const melody = melodyOf(tracks, track >= 0 ? track : undefined).slice(0, cap);
      const notes = melody.map((n) => n.note);
      const res = await rip(toIntervals(notes), 100);
      if (res instanceof Error) return Response.json({ error: res.message }, { status: 502 });
      return Response.json({
        melody: melody.map((n) => [n.tick, n.note]),
        motifs: res.motifs.map((m) => ({
          ...m,
          // note-index spans for highlighting: an occurrence at interval i
          // covers notes i..i+len (inclusive)
          spans: m.occurrences.map((i) => [i, i + m.unit.length]),
          preview: notes
            .slice(m.occurrences[0], m.occurrences[0] + m.unit.length + 1)
            .map(noteName)
            .join(" "),
        })),
        tries: res.tries,
        budgetExhausted: res.budgetExhausted,
      });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 4173);
  Bun.serve({ port, fetch: handle });
  console.log(`jev-riffs listening on http://localhost:${port}`);
}
