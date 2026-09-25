import { test, expect } from "bun:test";
import { handle } from "./server";

// same hand-assembled fixture style as midi.test.ts
function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function track(...events: number[][]): number[] {
  const body = [...events.flat(), 0x00, 0xff, 0x2f, 0x00];
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
}
function midi(...tracks: number[][]): Uint8Array {
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, ...u32(6), 0x00, 0x01, 0x00, tracks.length, 0x01, 0xe0,
    ...tracks.flat(),
  ]);
}

test("serves the page", async () => {
  const res = await handle(new Request("http://x/"));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("jev‑riffs");
});

test("api/parse returns tracks, notes and a suggested track", async () => {
  const bytes = midi(
    track([0x00, 0xff, 0x03, 4, 0x4f, 0x42, 0x4f, 0x45], [0x00, 0x90, 60, 64], [0x0a, 0x90, 62, 64]),
    track([0x00, 0x90, 70, 64])
  );
  const res = await handle(new Request("http://x/api/parse", { method: "POST", body: bytes }));
  expect(res.status).toBe(200);
  const json: any = await res.json();
  expect(json.tracks.length).toBe(2);
  expect(json.tracks[0].name).toBe("OBOE");
  expect(json.tracks[0].notes).toEqual([[0, 60], [10, 62]]);
  expect(json.suggested).toBe(0);
});

test("api/parse rejects non-midi bytes", async () => {
  const res = await handle(
    new Request("http://x/api/parse", { method: "POST", body: new Uint8Array([1, 2, 3]) })
  );
  expect(res.status).toBe(400);
});

test("unknown path 404s", async () => {
  expect((await handle(new Request("http://x/nope"))).status).toBe(404);
});
