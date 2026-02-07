const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export const fmtTime = (seconds) => {
  const totalMs = Math.round((Number(seconds) || 0) * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60);
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
};

export const createInitialSegment = (duration) => ({
  id: crypto.randomUUID(),
  label: "Clip 1",
  sourceId: null,
  start: 0,
  end: duration,
  timelineDuration: duration,
});

export const sourceLength = (seg) => Math.max(0.00001, seg.end - seg.start);
export const segmentLength = (seg) =>
  Math.max(0.00001, Number.isFinite(seg.timelineDuration) ? seg.timelineDuration : sourceLength(seg));

export function rebuildComposedDuration(model) {
  model.composedDuration = model.segments.reduce((sum, seg) => sum + segmentLength(seg), 0);
}

export function clipStartInTimeline(segments, index) {
  let start = 0;
  for (let i = 0; i < index; i += 1) start += segmentLength(segments[i]);
  return start;
}

export function getEventsForTimelineTime(model, timelineTime) {
  const events = [];
  const sources = Array.isArray(model.sources) ? model.sources : [];
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  let accTimeline = 0;
  for (const seg of model.segments) {
    const source = seg.sourceId ? sourceById.get(seg.sourceId) : null;
    const segOutputEvents = source ? source.outputEvents : model.outputEvents;
    const timelineLen = segmentLength(seg);
    const srcLen = sourceLength(seg);
    const remaining = timelineTime - accTimeline;
    const offset = remaining >= timelineLen ? timelineLen : clamp(remaining, 0, timelineLen);
    const ratio = timelineLen <= 0 ? 1 : offset / timelineLen;
    const cutoff = seg.start + srcLen * ratio;
    for (const ev of segOutputEvents) {
      if (ev.time >= seg.start && ev.time <= cutoff) {
        events.push({ time: ev.time, data: ev.data });
      }
    }
    if (remaining < timelineLen) break;
    accTimeline += timelineLen;
  }
  return events;
}

export function timelineToSourceTime(model, timelineTime) {
  let cursor = 0;
  for (const seg of model.segments) {
    const timelineLen = segmentLength(seg);
    const srcLen = sourceLength(seg);
    if (timelineTime <= cursor + timelineLen || seg === model.segments[model.segments.length - 1]) {
      const offset = clamp(timelineTime - cursor, 0, timelineLen);
      const ratio = timelineLen <= 0 ? 1 : offset / timelineLen;
      return seg.start + srcLen * ratio;
    }
    cursor += timelineLen;
  }
  return 0;
}

export function splitAtPlayhead(model) {
  if (!model.segments.length || model.playheadTime <= 0 || model.playheadTime >= model.composedDuration) return false;
  let cursor = 0;
  for (let i = 0; i < model.segments.length; i += 1) {
    const seg = model.segments[i];
    const timelineLen = segmentLength(seg);
    const srcLen = sourceLength(seg);
    if (model.playheadTime > cursor && model.playheadTime < cursor + timelineLen) {
      const offset = model.playheadTime - cursor;
      const ratio = clamp(offset / timelineLen, 0, 1);
      const splitSourceTime = seg.start + srcLen * ratio;
      if (splitSourceTime <= seg.start + 0.01 || splitSourceTime >= seg.end - 0.01) return false;
      const left = {
        ...seg,
        id: crypto.randomUUID(),
        end: splitSourceTime,
        timelineDuration: Math.max(0.01, timelineLen * ratio),
        label: `${seg.label} A`,
      };
      const right = {
        ...seg,
        id: crypto.randomUUID(),
        start: splitSourceTime,
        timelineDuration: Math.max(0.01, timelineLen * (1 - ratio)),
        label: `${seg.label} B`,
      };
      model.segments.splice(i, 1, left, right);
      model.selectedClipId = left.id;
      return true;
    }
    cursor += timelineLen;
  }
  return false;
}

export function moveSegment(model, sourceId, targetId, placeAfter = false) {
  const sourceIndex = model.segments.findIndex((segment) => segment.id === sourceId);
  const targetIndex = model.segments.findIndex((segment) => segment.id === targetId);
  if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) return false;

  const [segment] = model.segments.splice(sourceIndex, 1);
  let insertionIndex = targetIndex;
  if (sourceIndex < targetIndex) insertionIndex -= 1;
  if (placeAfter) insertionIndex += 1;
  insertionIndex = clamp(insertionIndex, 0, model.segments.length);
  model.segments.splice(insertionIndex, 0, segment);
  model.selectedClipId = segment.id;
  return true;
}

export function buildEditedCast(model) {
  const newEvents = [];
  let timelineCursor = 0;
  const sources = Array.isArray(model.sources) ? model.sources : [];
  const sourceById = new Map(sources.map((source) => [source.id, source]));

  for (const seg of model.segments) {
    const source = seg.sourceId ? sourceById.get(seg.sourceId) : null;
    const segEvents = source ? source.events : model.events;
    const srcLen = sourceLength(seg);
    const timelineLen = segmentLength(seg);
    for (const ev of segEvents) {
      if (!Array.isArray(ev) || ev.length < 3) continue;
      const t = Number(ev[0]);
      if (!Number.isFinite(t)) continue;
      if (t >= seg.start && t <= seg.end) {
        const ratio = srcLen <= 0 ? 0 : (t - seg.start) / srcLen;
        const mapped = timelineCursor + ratio * timelineLen;
        newEvents.push([Number(mapped.toFixed(6)), ev[1], ev[2]]);
      }
    }
    timelineCursor += timelineLen;
  }

  return {
    ...(model.header || {}),
    version: 2,
    events: newEvents,
  };
}

export function firstVisiblePreviewTime(outputEvents, duration) {
  if (!outputEvents.length) return 0;
  const firstTime = Math.max(0, Number(outputEvents[0].time) || 0);
  return clamp(firstTime + 0.2, 0, duration);
}

export { clamp };
