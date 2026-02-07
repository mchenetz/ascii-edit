const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function normalizeHeader(header) {
  if (!header || typeof header !== "object") {
    throw new Error("Invalid cast header");
  }
  if (!header.version) {
    throw new Error("Missing cast version in header");
  }

  const width = Number(header.width ?? header.term?.cols ?? 80);
  const height = Number(header.height ?? header.term?.rows ?? 24);

  return {
    ...header,
    width: Number.isFinite(width) ? clamp(width, 1, 2000) : 80,
    height: Number.isFinite(height) ? clamp(height, 1, 2000) : 24,
  };
}

function normalizeEvents(events, version) {
  const normalized = [];
  let cursor = 0;
  let prevRaw = -Infinity;
  const useDelta = Number(version) >= 3;

  for (const event of events) {
    if (!Array.isArray(event) || event.length < 3) continue;
    const rawTime = Number(event[0]);
    if (!Number.isFinite(rawTime)) continue;

    let absTime = rawTime;
    if (useDelta) {
      cursor += Math.max(0, rawTime);
      absTime = cursor;
    } else if (rawTime < prevRaw) {
      cursor += Math.max(0, rawTime);
      absTime = cursor;
    } else {
      cursor = rawTime;
    }

    prevRaw = rawTime;
    normalized.push([absTime, event[1], event[2]]);
  }

  return normalized;
}

export function parseCast(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Cast file is empty");
  }

  let header;
  let rawEvents;

  try {
    const parsed = JSON.parse(trimmed);
    header = normalizeHeader(parsed);
    rawEvents = Array.isArray(parsed.events) ? parsed.events : null;
  } catch {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) {
      throw new Error("Expected JSON cast or line-based .cast format");
    }
    header = normalizeHeader(JSON.parse(lines[0]));
    rawEvents = lines.slice(1).map((line) => JSON.parse(line));
  }

  if (!Array.isArray(rawEvents)) {
    throw new Error("Expected events in cast payload");
  }

  const events = normalizeEvents(rawEvents, header.version);
  const outputEvents = events
    .filter((event) => event[1] === "o")
    .map(([time, , data]) => ({ time: Number(time), data: String(data) }))
    .filter((event) => Number.isFinite(event.time))
    .sort((a, b) => a.time - b.time);

  const duration = outputEvents.length ? outputEvents[outputEvents.length - 1].time : 0;

  return {
    header,
    events,
    outputEvents,
    duration,
  };
}
