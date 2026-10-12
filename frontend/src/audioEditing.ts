import type { Span } from "./types";

export function preciseTime(ms: number, hours = false) {
  const total = Math.max(0, Math.round(ms));
  const seconds = Math.floor(total / 1000);
  const parts = [
    String(Math.floor(seconds / 60) % 60).padStart(2, "0"),
    String(seconds % 60).padStart(2, "0"),
  ];
  if (hours || seconds >= 3600)
    parts.unshift(String(Math.floor(seconds / 3600)).padStart(2, "0"));
  return parts.join(":") + "." + String(total % 1000).padStart(3, "0");
}

/** Accept seconds, mm:ss.mmm, or hh:mm:ss.mmm, in recording time. */
export function parseAudioTime(text: string): number | null {
  const value = text.trim();
  if (!/^\d+(?::\d+){0,2}(?:\.\d{0,3})?$/.test(value)) return null;
  const parts = value.split(":").map(Number);
  if (!parts.every(Number.isFinite)) return null;
  if (parts.length > 1 && parts.at(-1)! >= 60) return null;
  if (parts.length === 3 && parts[1] >= 60) return null;
  const ms = Math.round(parts.reduce((sum, part) => sum * 60 + part, 0) * 1000);
  return Number.isSafeInteger(ms) ? ms : null;
}

export function removedRanges(spans: Span[], duration: number): Span[] {
  const out: Span[] = [];
  let previous = 0;
  for (const span of spans) {
    if (span.start_ms > previous)
      out.push({ start_ms: previous, end_ms: span.start_ms });
    previous = span.end_ms;
  }
  if (previous < duration) out.push({ start_ms: previous, end_ms: duration });
  return out;
}

export function removeRange(spans: Span[], range: Span): Span[] {
  return spans.flatMap((span) => {
    if (range.end_ms <= span.start_ms || range.start_ms >= span.end_ms)
      return [span];
    const out: Span[] = [];
    if (range.start_ms > span.start_ms)
      out.push({ start_ms: span.start_ms, end_ms: range.start_ms });
    if (range.end_ms < span.end_ms)
      out.push({ start_ms: range.end_ms, end_ms: span.end_ms });
    return out;
  });
}

export function restoreRange(spans: Span[], range: Span): Span[] {
  const out: Span[] = [];
  for (const span of [...spans, range].sort(
    (a, b) => a.start_ms - b.start_ms,
  )) {
    const last = out.at(-1);
    if (last && span.start_ms <= last.end_ms)
      last.end_ms = Math.max(last.end_ms, span.end_ms);
    else out.push({ ...span });
  }
  return out;
}

export function editedPosition(spans: Span[], at: number): number | null {
  let offset = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (
      at >= span.start_ms &&
      (at < span.end_ms || (i === spans.length - 1 && at === span.end_ms))
    )
      return offset + at - span.start_ms;
    offset += span.end_ms - span.start_ms;
  }
  return null;
}

export function overviewPath(peaks: number[]) {
  const bins = Math.min(500, peaks.length);
  if (!bins) return "";
  const points = Array.from({ length: bins }, (_, i) => {
    const start = Math.floor((i * peaks.length) / bins);
    const end = Math.max(
      start + 1,
      Math.floor(((i + 1) * peaks.length) / bins),
    );
    let peak = 0;
    for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(peaks[j]));
    return { x: (i * 1000) / Math.max(1, bins - 1), y: Math.max(1, peak * 17) };
  });
  return (
    "M " +
    points
      .map((p) => `${p.x.toFixed(1)},${(20 - p.y).toFixed(1)}`)
      .join(" L ") +
    " L " +
    points
      .reverse()
      .map((p) => `${p.x.toFixed(1)},${(20 + p.y).toFixed(1)}`)
      .join(" L ") +
    " Z"
  );
}
