// Subtitle (SRT) helpers: one cue per sentence, spread across each scene's time slot.
export const srtTime = (t: number): string => {
  const ms = Math.max(0, Math.round(t * 1000)), p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
};

export function buildSrt(texts: string[], timings: number[][]): string {
  const cues: string[] = []; let n = 0;
  texts.forEach((text, i) => {
    const tm = timings[i]; if (!tm) return;
    const s = tm[0], e = Math.max(s + 0.5, tm[1] - 0.25);
    const parts = String(text).trim().split(/(?<=[.!?।？！])\s+/).filter(Boolean); if (!parts.length) return;
    const total = parts.reduce((a, p) => a + p.length, 0); let t = s;
    for (const p of parts) { const d = ((e - s) * p.length) / total; cues.push(`${++n}\n${srtTime(t)} --> ${srtTime(t + d)}\n${p}\n`); t += d; }
  });
  return cues.join("\n");
}
