import React, { useEffect, useMemo, useRef, useState } from "react";
import { FloatingPanel } from "./components/FloatingPanel";
import { parseCast } from "./lib/castParser";
import { getTerminalTheme, renderTerminalToHtml } from "./lib/terminalRenderer";
import {
  buildEditedCast,
  clamp,
  clipStartInTimeline,
  createInitialSegment,
  firstVisiblePreviewTime,
  fmtTime,
  getEventsForTimelineTime,
  moveSegment,
  rebuildComposedDuration,
  segmentLength,
  sourceLength,
  splitAtPlayhead,
} from "./lib/editorOps";

const LAYOUT_STORAGE_KEY = "ascii-edit.layout.v1";
const SHORTCUTS_STORAGE_KEY = "ascii-edit.shortcuts.v1";
const PROJECTS_STORAGE_KEY = "ascii-edit.projects.v1";
const LAYOUT_GRID = 20;
const SNAP_THRESHOLD = 10;
const DEFAULT_SHORTCUTS = {
  split: "/",
  heal: "H",
  copyClip: "C",
  cutClip: "X",
  deleteClip: "Delete",
  pasteBefore: "Alt+V",
  pasteAfter: "V",
  scaleClip: "S",
  scaleSelected: "Shift+S",
  playPause: "Space",
  rewind: "Home",
};
const SHORTCUT_FIELDS = [
  { key: "split", label: "Split" },
  { key: "heal", label: "Heal" },
  { key: "copyClip", label: "Copy Clip" },
  { key: "cutClip", label: "Cut Clip" },
  { key: "deleteClip", label: "Delete Clip" },
  { key: "pasteBefore", label: "Paste Before" },
  { key: "pasteAfter", label: "Paste After" },
  { key: "scaleClip", label: "Scale Clip" },
  { key: "scaleSelected", label: "Scale Selected" },
  { key: "playPause", label: "Play/Pause" },
  { key: "rewind", label: "Rewind" },
];

function createModel() {
  return {
    projectName: "Untitled Project",
    header: null,
    events: [],
    outputEvents: [],
    duration: 0,
    sources: [],
    selectedSourceId: null,
    composedDuration: 0,
    segments: [],
    selectedClipId: null,
    selectedClipIds: [],
    playheadTime: 0,
    playing: false,
    speed: 1,
    clipboardSegment: null,
    dragClipId: null,
    dragSourceId: null,
    contextMenu: { visible: false, x: 0, y: 0, clipId: null },
    settings: {
      shortcuts: { ...DEFAULT_SHORTCUTS },
    },
    status: "No cast loaded.",
    history: [],
    historyIndex: -1,
    panels: null,
  };
}

function cloneSnapshot(model) {
  return {
    projectName: model.projectName,
    segments: model.segments.map((segment) => ({ ...segment })),
    events: model.events.map((event) => (Array.isArray(event) ? [...event] : event)),
    outputEvents: model.outputEvents.map((event) => ({ ...event })),
    duration: model.duration,
    sources: model.sources.map((source) => ({ ...source })),
    selectedSourceId: model.selectedSourceId,
    selectedClipId: model.selectedClipId,
    selectedClipIds: [...model.selectedClipIds],
    playheadTime: model.playheadTime,
    status: model.status,
  };
}

function snapshotsEqual(a, b) {
  if (!a || !b) return false;
  if (a.projectName !== b.projectName) return false;
  if (a.selectedSourceId !== b.selectedSourceId) return false;
  if (a.selectedClipId !== b.selectedClipId) return false;
  if (JSON.stringify(a.selectedClipIds) !== JSON.stringify(b.selectedClipIds)) return false;
  if (Math.abs(a.playheadTime - b.playheadTime) > 0.00001) return false;
  if (a.events.length !== b.events.length) return false;
  return (
    JSON.stringify(a.segments) === JSON.stringify(b.segments) &&
    JSON.stringify(a.events) === JSON.stringify(b.events) &&
    JSON.stringify(a.sources) === JSON.stringify(b.sources)
  );
}

function applySnapshot(model, snapshot) {
  if (!snapshot) return;
  model.projectName = snapshot.projectName || model.projectName;
  model.segments = snapshot.segments.map((segment) => ({ ...segment }));
  model.events = snapshot.events.map((event) => (Array.isArray(event) ? [...event] : event));
  model.outputEvents = snapshot.outputEvents.map((event) => ({ ...event }));
  model.duration = snapshot.duration;
  model.sources = Array.isArray(snapshot.sources) ? snapshot.sources.map((source) => ({ ...source })) : [];
  model.selectedSourceId = snapshot.selectedSourceId || null;
  model.selectedClipId = snapshot.selectedClipId;
  model.selectedClipIds = Array.isArray(snapshot.selectedClipIds)
    ? [...snapshot.selectedClipIds]
    : (snapshot.selectedClipId ? [snapshot.selectedClipId] : []);
  model.playheadTime = snapshot.playheadTime;
  model.status = snapshot.status || model.status;
  rebuildComposedDuration(model);
  model.playheadTime = clamp(model.playheadTime, 0, model.composedDuration);
}

function defaultPanels(board) {
  const width = Math.max(board.width, 800);
  const height = Math.max(board.height, 600);
  const gap = 14;
  const browserWidth = Math.max(280, Math.min(360, width * 0.27));
  const panelWidth = Math.max(420, Math.min(width - gap * 3 - browserWidth, 1200));
  const previewHeight = Math.max(280, Math.min(height * 0.56, 640));
  const timelineHeight = Math.max(240, Math.min(height * 0.38, 460));

  return {
    browser: {
      x: gap,
      y: gap,
      w: browserWidth,
      h: Math.max(320, height - gap * 2),
      z: 2,
    },
    preview: {
      x: clamp(gap * 2 + browserWidth, 0, Math.max(0, width - panelWidth)),
      y: gap,
      w: panelWidth,
      h: previewHeight,
      z: 3,
    },
    timeline: {
      x: clamp(gap * 2 + browserWidth, 0, Math.max(0, width - panelWidth)),
      y: clamp(gap + previewHeight + gap, 0, Math.max(0, height - timelineHeight)),
      w: panelWidth,
      h: timelineHeight,
      z: 4,
    },
  };
}

function clampPanelsToBoard(panels, board) {
  if (!panels) return panels;
  const next = { ...panels };
  for (const key of Object.keys(next)) {
    const panel = { ...next[key] };
    panel.w = clamp(panel.w, 300, Math.max(300, board.width));
    panel.h = clamp(panel.h, 180, Math.max(180, board.height));
    panel.x = clamp(panel.x, 0, Math.max(0, board.width - panel.w));
    panel.y = clamp(panel.y, 0, Math.max(0, board.height - panel.h));
    next[key] = panel;
  }
  return next;
}

function snapValue(value, candidates, threshold = SNAP_THRESHOLD) {
  let best = value;
  let bestDist = threshold + 1;
  for (const candidate of candidates) {
    const dist = Math.abs(value - candidate);
    if (dist <= threshold && dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}

function snapLayoutToMagnet(id, layout, mode, panels, board) {
  const next = { ...layout };
  if (!panels) return next;

  next.w = Math.max(300, Math.min(next.w, board.width));
  next.h = Math.max(180, Math.min(next.h, board.height));
  next.x = Math.min(Math.max(0, next.x), Math.max(0, board.width - next.w));
  next.y = Math.min(Math.max(0, next.y), Math.max(0, board.height - next.h));

  const others = Object.entries(panels)
    .filter(([panelId]) => panelId !== id)
    .map(([, panel]) => panel);

  if (mode === "move") {
    next.x = Math.round(next.x / LAYOUT_GRID) * LAYOUT_GRID;
    next.y = Math.round(next.y / LAYOUT_GRID) * LAYOUT_GRID;
    next.x = Math.min(Math.max(0, next.x), Math.max(0, board.width - next.w));
    next.y = Math.min(Math.max(0, next.y), Math.max(0, board.height - next.h));

    const xCandidates = [0, board.width - next.w];
    const yCandidates = [0, board.height - next.h];
    others.forEach((panel) => {
      xCandidates.push(panel.x);
      xCandidates.push(panel.x + panel.w);
      xCandidates.push(panel.x - next.w);
      xCandidates.push(panel.x + panel.w - next.w);

      yCandidates.push(panel.y);
      yCandidates.push(panel.y + panel.h);
      yCandidates.push(panel.y - next.h);
      yCandidates.push(panel.y + panel.h - next.h);
    });

    next.x = snapValue(next.x, xCandidates);
    next.y = snapValue(next.y, yCandidates);
    next.x = Math.min(Math.max(0, next.x), Math.max(0, board.width - next.w));
    next.y = Math.min(Math.max(0, next.y), Math.max(0, board.height - next.h));
    return next;
  }

  if (mode === "resize") {
    next.w = Math.round(next.w / LAYOUT_GRID) * LAYOUT_GRID;
    next.h = Math.round(next.h / LAYOUT_GRID) * LAYOUT_GRID;

    const right = next.x + next.w;
    const bottom = next.y + next.h;

    const rightCandidates = [board.width];
    const bottomCandidates = [board.height];
    others.forEach((panel) => {
      rightCandidates.push(panel.x);
      rightCandidates.push(panel.x + panel.w);
      bottomCandidates.push(panel.y);
      bottomCandidates.push(panel.y + panel.h);
    });

    const snappedRight = snapValue(right, rightCandidates);
    const snappedBottom = snapValue(bottom, bottomCandidates);

    next.w = snappedRight - next.x;
    next.h = snappedBottom - next.y;
    next.w = Math.max(300, Math.min(next.w, board.width - next.x));
    next.h = Math.max(180, Math.min(next.h, board.height - next.y));
    return next;
  }

  return next;
}

function normalizeShortcutKey(key) {
  if (!key) return "";
  if (key === " ") return "Space";
  if (key.length === 1) return key;
  return key[0].toUpperCase() + key.slice(1);
}

function eventToShortcut(event) {
  const parts = [];
  if (event.metaKey) parts.push("Meta");
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(normalizeShortcutKey(event.key));
  return parts.join("+");
}

export function App() {
  const modelRef = useRef(createModel());
  const workspaceRef = useRef(null);
  const timelineTrackRef = useRef(null);
  const rafRef = useRef(0);
  const lastFrameTsRef = useRef(0);
  const previewPopupRef = useRef(null);
  const asciinemaPreviewReqRef = useRef(0);
  const [rev, setRev] = useState(0);
  const [boardRect, setBoardRect] = useState({ width: 1200, height: 820 });
  const [browserDropActive, setBrowserDropActive] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [browserTab, setBrowserTab] = useState("project");
  const [savedProjects, setSavedProjects] = useState([]);
  const [asciinemaCategory, setAsciinemaCategory] = useState("recent");
  const [asciinemaClips, setAsciinemaClips] = useState([]);
  const [asciinemaLoading, setAsciinemaLoading] = useState(false);
  const [asciinemaError, setAsciinemaError] = useState("");
  const [asciinemaRefreshTick, setAsciinemaRefreshTick] = useState(0);
  const [asciinemaSelectedClipId, setAsciinemaSelectedClipId] = useState("");
  const [asciinemaPreviewSource, setAsciinemaPreviewSource] = useState(null);
  const [asciinemaPreviewTime, setAsciinemaPreviewTime] = useState(0);
  const [asciinemaPreviewLoading, setAsciinemaPreviewLoading] = useState(false);
  const [previewPoppedOut, setPreviewPoppedOut] = useState(false);

  const forceRender = () => setRev((value) => value + 1);
  const model = modelRef.current;

  const recordHistory = () => {
    const snapshot = cloneSnapshot(modelRef.current);
    const model = modelRef.current;
    const current = model.history[model.historyIndex];
    if (current && snapshotsEqual(current, snapshot)) return;

    model.history = model.history.slice(0, model.historyIndex + 1);
    model.history.push(snapshot);
    if (model.history.length > 200) model.history.shift();
    model.historyIndex = model.history.length - 1;
  };

  const resetHistory = () => {
    const model = modelRef.current;
    model.history = [cloneSnapshot(model)];
    model.historyIndex = 0;
  };

  const mutate = (mutator, options = {}) => {
    const { record = true, rerender = true } = options;
    const model = modelRef.current;
    mutator(model);
    rebuildComposedDuration(model);
    const previewClampMax = browserTab === "asciinema" && asciinemaPreviewSource?.header
      ? Math.max(model.composedDuration, asciinemaPreviewSource.duration || 0)
      : model.composedDuration;
    model.playheadTime = clamp(model.playheadTime, 0, previewClampMax);
    if (record) recordHistory();
    if (rerender) forceRender();
  };

  const stopPlayback = () => {
    const model = modelRef.current;
    model.playing = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    lastFrameTsRef.current = 0;
  };

  const startPlayback = () => {
    if (rafRef.current) return;

    const tick = (ts) => {
      const model = modelRef.current;
      if (!model.playing) {
        rafRef.current = 0;
        lastFrameTsRef.current = 0;
        return;
      }

      if (!lastFrameTsRef.current) lastFrameTsRef.current = ts;
      const delta = (ts - lastFrameTsRef.current) / 1000;
      lastFrameTsRef.current = ts;

      model.playheadTime += delta * model.speed;
      if (model.playheadTime >= model.composedDuration) {
        model.playheadTime = model.composedDuration;
        model.playing = false;
      }

      forceRender();
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    if (!workspaceRef.current) return undefined;

    const update = () => {
      const rect = workspaceRef.current.getBoundingClientRect();
      const nextBoard = {
        width: Math.max(480, Math.floor(rect.width)),
        height: Math.max(540, Math.floor(rect.height)),
      };
      setBoardRect(nextBoard);
      const model = modelRef.current;
      if (!model.panels) {
        const fallback = defaultPanels(nextBoard);
        try {
          const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed?.preview && parsed?.timeline && parsed?.browser) {
              model.panels = clampPanelsToBoard(parsed, nextBoard);
            } else {
              model.panels = fallback;
            }
          } else {
            model.panels = fallback;
          }
        } catch {
          model.panels = fallback;
        }
      } else {
        model.panels = clampPanelsToBoard(model.panels, nextBoard);
      }
      forceRender();
    };

    update();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(update);
      observer.observe(workspaceRef.current);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SHORTCUTS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      mutate(
        (m) => {
          m.settings = {
            shortcuts: {
              ...DEFAULT_SHORTCUTS,
              ...(parsed.shortcuts || {}),
            },
          };
        },
        { record: false },
      );
    } catch {
      // ignore malformed saved shortcut settings
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveShortcutsToStorage = (shortcuts) => {
    try {
      window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify({ shortcuts }));
    } catch {
      // ignore storage failures
    }
  };

  const readSavedProjects = () => {
    try {
      const raw = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const writeSavedProjects = (projects) => {
    window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  };

  const refreshSavedProjects = () => {
    setSavedProjects(readSavedProjects());
  };

  useEffect(() => {
    refreshSavedProjects();
  }, []);

  useEffect(() => {
    const onClick = (event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(".context-menu")) return;
      if (!event.target.closest(".settings-wrap") && settingsOpen) {
        setSettingsOpen(false);
      }
      if (modelRef.current.contextMenu.visible) {
        modelRef.current.contextMenu = { visible: false, x: 0, y: 0, clipId: null };
        forceRender();
      }
    };

    const onKeyDown = (event) => {
      const model = modelRef.current;
      const target = event.target;
      const typingTarget =
        target instanceof HTMLElement
        && (target.tagName === "INPUT"
          || target.tagName === "TEXTAREA"
          || target.tagName === "SELECT"
          || target.isContentEditable);
      const shortcuts = model.settings?.shortcuts || DEFAULT_SHORTCUTS;
      const pressed = eventToShortcut(event).toLowerCase();
      const isShortcut = (name) => (shortcuts[name] || "").toLowerCase() === pressed;
      const activeClipId = model.selectedClipId;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (model.historyIndex > 0) {
          model.historyIndex -= 1;
          applySnapshot(model, model.history[model.historyIndex]);
          forceRender();
        }
      }
      if (!typingTarget && isShortcut("split")) {
        event.preventDefault();
        mutate((m) => {
          if (!m.header || !m.segments.length) return;
          splitAtPlayhead(m);
        });
      }
      if (!typingTarget && isShortcut("playPause")) {
        event.preventDefault();
        const m = modelRef.current;
        if (!m.header || !m.segments.length) return;
        m.playing = !m.playing;
        if (m.playing) startPlayback();
        else stopPlayback();
        forceRender();
      }
      if (!typingTarget && isShortcut("rewind")) {
        event.preventDefault();
        mutate(
          (m) => {
            m.playheadTime = 0;
            m.playing = false;
          },
          { record: false },
        );
      }
      if (!typingTarget && isShortcut("heal")) {
        event.preventDefault();
        healSelectedClips();
      }
      if (!typingTarget && isShortcut("copyClip") && activeClipId) {
        event.preventDefault();
        applyMenuAction("copy", activeClipId);
      }
      if (!typingTarget && isShortcut("cutClip") && activeClipId) {
        event.preventDefault();
        applyMenuAction("cut", activeClipId);
      }
      if (!typingTarget && isShortcut("deleteClip") && activeClipId) {
        event.preventDefault();
        applyMenuAction("delete", activeClipId);
      }
      if (!typingTarget && isShortcut("pasteBefore") && activeClipId) {
        event.preventDefault();
        applyMenuAction("paste-before", activeClipId);
      }
      if (!typingTarget && isShortcut("pasteAfter") && activeClipId) {
        event.preventDefault();
        applyMenuAction("paste-after", activeClipId);
      }
      if (!typingTarget && isShortcut("scaleClip") && activeClipId) {
        event.preventDefault();
        applyMenuAction("scale-clip", activeClipId);
      }
      if (!typingTarget && isShortcut("scaleSelected")) {
        event.preventDefault();
        applyMenuAction("scale-selected");
      }
      if (event.key === "Escape" && model.contextMenu.visible) {
        model.contextMenu = { visible: false, x: 0, y: 0, clipId: null };
        forceRender();
      }
    };

    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [settingsOpen]);

  useEffect(() => {
    const onDragOver = (event) => {
      if (!modelRef.current.dragClipId && !modelRef.current.dragSourceId) return;
      event.preventDefault();
    };
    const onDrop = (event) => {
      if (!modelRef.current.dragClipId && !modelRef.current.dragSourceId) return;
      event.preventDefault();
      modelRef.current.dragClipId = null;
      modelRef.current.dragSourceId = null;
      forceRender();
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const decodeHtmlToText = (html) => {
    if (!html) return "";
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.textContent || "";
  };

  const getSourceById = (m, sourceId) => (m.sources || []).find((source) => source.id === sourceId) || null;

  const getSegmentSourceLimit = (m, seg) => {
    if (!seg) return 0;
    if (!seg.sourceId) return m.duration;
    const source = getSourceById(m, seg.sourceId);
    return source?.duration || 0;
  };

  const previewFrame = useMemo(() => {
    if (browserTab === "asciinema" && asciinemaPreviewSource?.header) {
      const t = clamp(asciinemaPreviewTime, 0, asciinemaPreviewSource.duration || 0);
      const events = asciinemaPreviewSource.outputEvents.filter((event) => event.time <= t);
      const theme = getTerminalTheme(asciinemaPreviewSource.header);
      const html = renderTerminalToHtml(
        asciinemaPreviewSource.header.height || 24,
        asciinemaPreviewSource.header.width || 80,
        events,
        theme,
      );
      return { html, theme };
    }
    let activeSeg = null;
    let cursor = 0;
    for (const seg of model.segments) {
      const len = segmentLength(seg);
      if (model.playheadTime <= cursor + len) {
        activeSeg = seg;
        break;
      }
      cursor += len;
    }
    const activeSource = activeSeg?.sourceId ? getSourceById(model, activeSeg.sourceId) : null;
    const activeHeader = activeSource?.header || model.header || model.sources[0]?.header || null;
    if (!activeHeader) return { html: "", theme: { fg: "", bg: "" } };
    const events = getEventsForTimelineTime(model, model.playheadTime);
    const theme = getTerminalTheme(activeHeader);
    const html = renderTerminalToHtml(
      activeHeader.height || 24,
      activeHeader.width || 80,
      events,
      theme,
    );
    return { html, theme };
  }, [rev, browserTab, asciinemaPreviewSource, asciinemaPreviewTime]);

  const normalizeEventText = (text) =>
    String(text || "")
      .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
      .replace(/\u001b\[[0-9:;<=>?]*[@-~]/g, "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const clipPreviewMap = useMemo(() => {
    const map = new Map();
    if (!model.segments.length) return map;

    model.segments.forEach((seg, index) => {
      const source = seg.sourceId ? getSourceById(model, seg.sourceId) : null;
      const header = source?.header || model.header;
      if (!header) return;
      const rows = header.height || 24;
      const cols = header.width || 80;
      const theme = getTerminalTheme(header);
      const start = clipStartInTimeline(model.segments, index);
      const len = segmentLength(seg);
      const t = start + len / 2;
      const events = getEventsForTimelineTime(model, t);
      const html = renderTerminalToHtml(rows, cols, events, theme);
      const plain = decodeHtmlToText(html).replace(/\s+$/g, "");
      const preview = plain.split("\n").slice(0, 2).join(" ").trim();
      map.set(seg.id, preview || "(no output)");
    });
    return map;
  }, [rev]);

  const clipTextMarkers = useMemo(() => {
    const markers = new Map();
    if (!model.segments.length) return markers;

    model.segments.forEach((seg) => {
      const source = seg.sourceId ? getSourceById(model, seg.sourceId) : null;
      const segOutputEvents = source?.outputEvents || model.outputEvents;
      if (!segOutputEvents.length) {
        markers.set(seg.id, []);
        return;
      }
      const len = sourceLength(seg);
      const inSeg = segOutputEvents
        .filter((event) => event.time >= seg.start && event.time <= seg.end)
        .map((event) => ({
          t: (event.time - seg.start) / len,
          text: normalizeEventText(event.data),
        }))
        .filter((event) => event.text.length > 0);

      const picked = [];
      for (const event of inSeg) {
        const nearExisting = picked.some((entry) => Math.abs(entry.t - event.t) < 0.18);
        if (nearExisting) continue;
        picked.push(event);
        if (picked.length >= 4) break;
      }
      markers.set(seg.id, picked);
    });
    return markers;
  }, [rev]);

  const selectedClip = model.segments.find((segment) => segment.id === model.selectedClipId) || null;
  const selectedSource = getSourceById(model, model.selectedSourceId) || model.sources[0] || null;
  const canEdit = model.segments.length > 0 && !!model.header;
  const canUndo = canEdit && model.historyIndex > 0;
  const usingAsciinemaPreview = browserTab === "asciinema" && !!asciinemaPreviewSource?.header;
  const previewDuration = usingAsciinemaPreview
    ? Math.max(0, asciinemaPreviewSource?.duration || 0)
    : model.composedDuration;
  const previewTime = clamp(model.playheadTime, 0, Math.max(0, previewDuration));
  const effectivePreviewTime = usingAsciinemaPreview
    ? clamp(asciinemaPreviewTime, 0, Math.max(0, previewDuration))
    : previewTime;
  const healTolerance = 0.02;
  const healCandidate = (() => {
    if (model.selectedClipIds.length !== 2) return null;
    const firstIndex = model.segments.findIndex((seg) => seg.id === model.selectedClipIds[0]);
    const secondIndex = model.segments.findIndex((seg) => seg.id === model.selectedClipIds[1]);
    if (firstIndex < 0 || secondIndex < 0) return null;
    const leftIndex = Math.min(firstIndex, secondIndex);
    const rightIndex = Math.max(firstIndex, secondIndex);
    if (rightIndex !== leftIndex + 1) return null;
    const left = model.segments[leftIndex];
    const right = model.segments[rightIndex];
    if ((left.sourceId || null) !== (right.sourceId || null)) return null;
    if (Math.abs(left.end - right.start) > healTolerance) return null;
    return { leftIndex, rightIndex, left, right };
  })();
  const canHeal = !!healCandidate;

  const browserPreviewMap = useMemo(() => {
    const map = new Map();
    model.sources.forEach((source) => {
      if (!source.header) return;
      const theme = getTerminalTheme(source.header);
      const events = source.outputEvents.filter((event) => event.time <= source.scrubTime);
      const html = renderTerminalToHtml(
        Math.min(source.header.height || 24, 8),
        Math.min(source.header.width || 80, 64),
        events,
        theme,
      );
      map.set(source.id, { html, theme });
    });
    return map;
  }, [rev]);

  const openMenu = (event, clipId) => {
    event.preventDefault();
    event.stopPropagation();
    model.contextMenu = {
      visible: true,
      x: event.clientX,
      y: event.clientY,
      clipId,
    };
    if (!model.selectedClipIds.includes(clipId)) {
      model.selectedClipIds = [clipId];
    }
    model.selectedClipId = clipId;
    forceRender();
  };

  const scaleSingleClip = (clipId) => {
    const model = modelRef.current;
    const seg = model.segments.find((s) => s.id === clipId);
    if (!seg) return;
    const raw = window.prompt("Target clip duration in seconds:", segmentLength(seg).toFixed(3));
    if (raw === null) return;
    const target = Number(raw);
    if (!Number.isFinite(target) || target <= 0) return;
    mutate((m) => {
      const clip = m.segments.find((s) => s.id === clipId);
      if (!clip) return;
      clip.timelineDuration = Math.max(0.01, target);
      m.status = `Scaled clip to ${fmtTime(clip.timelineDuration)}.`;
    });
  };

  const scaleSelectedClipsTotal = () => {
    const model = modelRef.current;
    const selected = model.segments.filter((seg) => model.selectedClipIds.includes(seg.id));
    if (selected.length < 2) {
      model.status = "Select at least two clips before scaling selected total.";
      forceRender();
      return;
    }
    const currentTotal = selected.reduce((sum, seg) => sum + segmentLength(seg), 0);
    const raw = window.prompt("Target total duration for selected clips (seconds):", currentTotal.toFixed(3));
    if (raw === null) return;
    const target = Number(raw);
    if (!Number.isFinite(target) || target <= 0) return;

    mutate((m) => {
      const selectedSegs = m.segments.filter((seg) => m.selectedClipIds.includes(seg.id));
      const total = selectedSegs.reduce((sum, seg) => sum + segmentLength(seg), 0);
      if (total <= 0) return;
      const factor = target / total;
      selectedSegs.forEach((seg) => {
        seg.timelineDuration = Math.max(0.01, segmentLength(seg) * factor);
      });
      m.status = `Scaled ${selectedSegs.length} clips to ${fmtTime(target)} total.`;
    });
  };

  const healSelectedClips = () => {
    if (!canHeal) return;
    mutate((m) => {
      if (m.selectedClipIds.length !== 2) return;
      const i1 = m.segments.findIndex((seg) => seg.id === m.selectedClipIds[0]);
      const i2 = m.segments.findIndex((seg) => seg.id === m.selectedClipIds[1]);
      if (i1 < 0 || i2 < 0) return;
      const leftIndex = Math.min(i1, i2);
      const rightIndex = Math.max(i1, i2);
      if (rightIndex !== leftIndex + 1) return;
      const left = m.segments[leftIndex];
      const right = m.segments[rightIndex];
      if ((left.sourceId || null) !== (right.sourceId || null)) return;
      if (Math.abs(left.end - right.start) > healTolerance) return;

      const merged = {
        ...left,
        id: crypto.randomUUID(),
        end: right.end,
        timelineDuration: segmentLength(left) + segmentLength(right),
        label: left.label.replace(/\s+[AB]$/i, "") || left.label,
      };

      m.segments.splice(leftIndex, 2, merged);
      m.selectedClipId = merged.id;
      m.selectedClipIds = [merged.id];
      m.status = `Healed clips into ${fmtTime(merged.start)} - ${fmtTime(merged.end)}.`;
    });
  };

  const applyMenuAction = (action, clipIdOverride = null) => {
    const model = modelRef.current;
    const clipId = clipIdOverride || model.contextMenu.clipId || model.selectedClipId;
    const clipIndex = clipId ? model.segments.findIndex((segment) => segment.id === clipId) : -1;
    const clip = clipIndex >= 0 ? model.segments[clipIndex] : null;

    if (action === "scale-selected") {
      model.contextMenu = { visible: false, x: 0, y: 0, clipId: null };
      forceRender();
      scaleSelectedClipsTotal();
      return;
    }
    if (!clip) return;

    if (action === "copy") {
      model.clipboardSegment = { ...clip };
      model.contextMenu = { visible: false, x: 0, y: 0, clipId: null };
      forceRender();
      return;
    }

    if (action === "cut") {
      if (model.segments.length <= 1) return;
      mutate((m) => {
        m.clipboardSegment = { ...clip };
        m.segments.splice(clipIndex, 1);
        m.selectedClipId = m.segments[Math.max(0, clipIndex - 1)]?.id ?? null;
        m.selectedClipIds = m.selectedClipId ? [m.selectedClipId] : [];
        m.contextMenu = { visible: false, x: 0, y: 0, clipId: null };
      });
      return;
    }

    if (action === "delete") {
      if (model.segments.length <= 1) return;
      mutate((m) => {
        m.segments.splice(clipIndex, 1);
        m.selectedClipId = m.segments[Math.max(0, clipIndex - 1)]?.id ?? null;
        m.selectedClipIds = m.selectedClipId ? [m.selectedClipId] : [];
        m.contextMenu = { visible: false, x: 0, y: 0, clipId: null };
      });
      return;
    }

    if (action === "scale-clip") {
      model.contextMenu = { visible: false, x: 0, y: 0, clipId: null };
      forceRender();
      scaleSingleClip(clip.id);
      return;
    }

    if (action === "paste-before" || action === "paste-after") {
      if (!model.clipboardSegment) return;
      mutate((m) => {
        const pasted = {
          ...m.clipboardSegment,
          id: crypto.randomUUID(),
          label: m.clipboardSegment.label.endsWith(" Copy")
            ? m.clipboardSegment.label
            : `${m.clipboardSegment.label} Copy`,
        };
        const at = action === "paste-before" ? clipIndex : clipIndex + 1;
        m.segments.splice(at, 0, pasted);
        m.selectedClipId = pasted.id;
        m.selectedClipIds = [pasted.id];
        m.contextMenu = { visible: false, x: 0, y: 0, clipId: null };
      });
    }
  };

  const parseSourceFile = async (file) => {
    const text = await file.text();
    const parsed = parseCast(text);
    const sourceId = crypto.randomUUID();
    return {
      id: sourceId,
      name: file.name,
      header: parsed.header,
      events: parsed.events,
      outputEvents: parsed.outputEvents,
      duration: parsed.duration,
      scrubTime: firstVisiblePreviewTime(parsed.outputEvents, parsed.duration),
      inPoint: 0,
      outPoint: Math.max(0.01, parsed.duration),
    };
  };

  const parseSourceText = (name, text) => {
    const parsed = parseCast(text);
    return {
      id: crypto.randomUUID(),
      name,
      header: parsed.header,
      events: parsed.events,
      outputEvents: parsed.outputEvents,
      duration: parsed.duration,
      scrubTime: firstVisiblePreviewTime(parsed.outputEvents, parsed.duration),
      inPoint: 0,
      outPoint: Math.max(0.01, parsed.duration),
    };
  };

  const addSourcesToModel = (sources, replace = false) => {
    stopPlayback();
    mutate(
      (m) => {
        if (replace) {
          m.sources = [];
          m.segments = [];
          m.selectedClipId = null;
          m.selectedClipIds = [];
          m.selectedSourceId = null;
        }
        const existing = new Set(m.sources.map((source) => `${source.name}:${source.duration.toFixed(6)}`));
        sources.forEach((source) => {
          const key = `${source.name}:${source.duration.toFixed(6)}`;
          if (!existing.has(key)) {
            m.sources.push(source);
            existing.add(key);
          }
        });

        const primary = m.sources[0] || null;
        if (!primary) return;
        m.header = primary.header;
        m.events = primary.events;
        m.outputEvents = primary.outputEvents;
        m.duration = primary.duration;
        m.selectedSourceId = m.selectedSourceId || primary.id;
        if (!m.segments.length) {
          const firstClip = {
            ...createInitialSegment(primary.duration),
            sourceId: primary.id,
            label: primary.name.replace(/\.(cast|asciicast|json)$/i, "") || "Clip 1",
          };
          m.segments = [firstClip];
          m.selectedClipId = firstClip.id;
          m.selectedClipIds = [firstClip.id];
          m.playheadTime = firstVisiblePreviewTime(primary.outputEvents, firstClip.timelineDuration);
        }
      },
      { record: false },
    );
    resetHistory();
    forceRender();
  };

  const isSupportedCastFile = (file) => /\.(cast|asciicast|json)$/i.test(file?.name || "");

  const loadSourceFiles = async (files, replace = false) => {
    const supported = files.filter(isSupportedCastFile);
    if (!supported.length) {
      modelRef.current.status = "No supported cast files found in selection.";
      forceRender();
      return;
    }

    const sources = [];
    let rejected = 0;
    for (const file of supported) {
      try {
        sources.push(await parseSourceFile(file));
      } catch {
        rejected += 1;
      }
    }
    if (!sources.length) {
      modelRef.current.status = "Could not parse any dropped files as asciicast.";
      forceRender();
      return;
    }

    addSourcesToModel(sources, replace);
    modelRef.current.status = rejected > 0
      ? `Loaded ${sources.length} file(s), skipped ${rejected}.`
      : `Loaded ${sources.length} file(s).`;
    forceRender();
  };

  const addSourceToTimeline = (sourceId, insertAtTime = null) => {
    mutate((m) => {
      const source = getSourceById(m, sourceId);
      if (!source) return;
      const start = clamp(source.inPoint, 0, Math.max(0, source.duration - 0.01));
      const end = clamp(source.outPoint, start + 0.01, source.duration);
      const clip = {
        id: crypto.randomUUID(),
        sourceId: source.id,
        label: source.name.replace(/\.(cast|asciicast|json)$/i, ""),
        start,
        end,
        timelineDuration: Math.max(0.01, end - start),
      };
      if (Number.isFinite(insertAtTime)) {
        const target = clamp(insertAtTime, 0, m.composedDuration);
        let insertIndex = m.segments.length;
        let cursor = 0;
        for (let i = 0; i < m.segments.length; i += 1) {
          const len = segmentLength(m.segments[i]);
          if (target <= cursor + len * 0.5) {
            insertIndex = i;
            break;
          }
          if (target <= cursor + len) {
            insertIndex = i + 1;
            break;
          }
          cursor += len;
        }
        m.segments.splice(insertIndex, 0, clip);
        m.playheadTime = clipStartInTimeline(m.segments, insertIndex);
      } else {
        m.segments.push(clip);
        m.playheadTime = clipStartInTimeline(m.segments, m.segments.length - 1);
      }
      m.selectedClipId = clip.id;
      m.selectedClipIds = [clip.id];
      m.status = `Added clip from ${source.name} (${fmtTime(start)} - ${fmtTime(end)}).`;
    });
  };

  const onLoadFiles = async (event, replace = false) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    try {
      await loadSourceFiles(files, replace);
    } catch (error) {
      stopPlayback();
      modelRef.current.status = `Error: ${error.message}`;
      forceRender();
    } finally {
      event.target.value = "";
    }
  };

  const createProjectStateSnapshot = () => {
    const m = modelRef.current;
    return {
      projectName: m.projectName,
      header: m.header,
      events: m.events,
      outputEvents: m.outputEvents,
      duration: m.duration,
      sources: m.sources,
      selectedSourceId: m.selectedSourceId,
      segments: m.segments,
      selectedClipId: m.selectedClipId,
      selectedClipIds: m.selectedClipIds,
      playheadTime: m.playheadTime,
      speed: m.speed,
      clipboardSegment: m.clipboardSegment,
      panels: m.panels,
      settings: m.settings,
      browserTab,
      asciinemaCategory,
      asciinemaSelectedClipId,
      asciinemaPreviewSource,
      asciinemaPreviewTime,
    };
  };

  const applyProjectStateSnapshot = (state) => {
    if (!state || typeof state !== "object") return;
    stopPlayback();
    mutate(
      (m) => {
        m.projectName = state.projectName || "Untitled Project";
        m.header = state.header || null;
        m.events = Array.isArray(state.events) ? state.events : [];
        m.outputEvents = Array.isArray(state.outputEvents) ? state.outputEvents : [];
        m.duration = Number(state.duration) || 0;
        m.sources = Array.isArray(state.sources) ? state.sources : [];
        m.selectedSourceId = state.selectedSourceId || null;
        m.segments = Array.isArray(state.segments) ? state.segments : [];
        m.selectedClipId = state.selectedClipId || null;
        m.selectedClipIds = Array.isArray(state.selectedClipIds) ? state.selectedClipIds : [];
        m.playheadTime = Number(state.playheadTime) || 0;
        m.speed = Number(state.speed) || 1;
        m.clipboardSegment = state.clipboardSegment || null;
        m.panels = state.panels || m.panels;
        m.settings = state.settings || { shortcuts: { ...DEFAULT_SHORTCUTS } };
        m.status = `Loaded project: ${m.projectName}`;
      },
      { record: false },
    );
    const restoredTab = state.browserTab === "local" ? "project" : (state.browserTab || "project");
    setBrowserTab(restoredTab);
    setAsciinemaCategory(state.asciinemaCategory || "recent");
    setAsciinemaSelectedClipId(state.asciinemaSelectedClipId || "");
    setAsciinemaPreviewSource(state.asciinemaPreviewSource || null);
    setAsciinemaPreviewTime(Number(state.asciinemaPreviewTime) || 0);
    resetHistory();
  };

  const saveCurrentProject = () => {
    const model = modelRef.current;
    const currentName = (model.projectName || "").trim();
    const shouldPrompt = !currentName || currentName === "Untitled Project";
    const trimmed = shouldPrompt
      ? (window.prompt("Project name:", currentName || "Untitled Project") || "").trim()
      : currentName;
    if (!trimmed) return;
    const snapshot = createProjectStateSnapshot();
    snapshot.projectName = trimmed;
    const projects = readSavedProjects();
    const existing = projects.find((project) => project.name === trimmed);
    const record = {
      id: existing?.id || crypto.randomUUID(),
      name: trimmed,
      updatedAt: new Date().toISOString(),
      state: snapshot,
    };
    const next = existing
      ? projects.map((project) => (project.id === existing.id ? record : project))
      : [record, ...projects];
    try {
      writeSavedProjects(next);
      mutate(
        (m) => {
          m.projectName = trimmed;
          m.status = `Saved project: ${trimmed}`;
        },
        { record: false },
      );
      refreshSavedProjects();
    } catch {
      mutate((m) => {
        m.status = "Could not save project to browser storage.";
      }, { record: false });
    }
  };

  const loadSavedProject = (projectId) => {
    const projects = readSavedProjects();
    const project = projects.find((entry) => entry.id === projectId);
    if (!project) return;
    applyProjectStateSnapshot(project.state);
  };

  const deleteSavedProject = (projectId) => {
    const projects = readSavedProjects();
    const next = projects.filter((entry) => entry.id !== projectId);
    writeSavedProjects(next);
    refreshSavedProjects();
    mutate((m) => {
      m.status = "Deleted saved project.";
    }, { record: false });
  };

  const updateShortcut = (name, shortcut) => {
    const next = {
      ...(modelRef.current.settings?.shortcuts || DEFAULT_SHORTCUTS),
      [name]: shortcut,
    };
    mutate(
      (m) => {
        m.settings = { shortcuts: next };
        m.status = `Shortcut updated: ${name} -> ${shortcut}`;
      },
      { record: false },
    );
    saveShortcutsToStorage(next);
  };

  const resetShortcuts = () => {
    mutate(
      (m) => {
        m.settings = { shortcuts: { ...DEFAULT_SHORTCUTS } };
        m.status = "Shortcuts reset to defaults.";
      },
      { record: false },
    );
    saveShortcutsToStorage({ ...DEFAULT_SHORTCUTS });
  };

  const extractAsciinemaClipsFromHtml = (html) => {
    const clips = [];
    const seen = new Set();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const links = Array.from(doc.querySelectorAll('a[href^="/a/"]'));

    links.forEach((anchor) => {
      const href = anchor.getAttribute("href") || "";
      const m = href.match(/^\/a\/([A-Za-z0-9_-]+)/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);

      const card = anchor.closest("article, li, .recording, .asciicast, .card, div") || anchor.parentElement;
      const rawTitle = (
        anchor.getAttribute("title")
        || anchor.getAttribute("aria-label")
        || anchor.querySelector("h1,h2,h3,h4")?.textContent
        || card?.querySelector("h1,h2,h3,h4")?.textContent
        || anchor.textContent
        || `Recording ${id}`
      ).trim();
      const title = rawTitle.replace(/\s+/g, " ");

      const tagLinks = card
        ? Array.from(card.querySelectorAll('a[href*="/tags/"], a[href*="tag="]'))
        : [];
      const tags = tagLinks
        .map((el) => (el.textContent || "").trim())
        .filter(Boolean)
        .slice(0, 8);

      const image = card?.querySelector("img");
      const src = image?.getAttribute("src");
      const thumbnailUrl = src
        ? new URL(src, "https://asciinema.org").toString()
        : `https://asciinema.org/a/${id}.svg`;

      const subtitle = card?.querySelector("time, .meta, .details, .author, .description")?.textContent?.trim() || "";

      clips.push({
        id,
        title,
        subtitle,
        tags,
        url: `https://asciinema.org/a/${id}`,
        castUrl: `https://asciinema.org/a/${id}.cast`,
        thumbnailUrl,
      });
    });

    clips.sort((a, b) => a.title.localeCompare(b.title));
    return clips;
  };

  const fetchTextWithCorsFallback = async (url) => {
    const attempts = [
      { label: "direct", url },
      { label: "allorigins", url: `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` },
    ];
    let lastError = null;
    for (const attempt of attempts) {
      try {
        const response = await fetch(attempt.url);
        if (!response.ok) {
          throw new Error(`${attempt.label} ${response.status}`);
        }
        return await response.text();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Failed to fetch URL");
  };

  const fetchAsciinemaClips = async (category) => {
    const pathMap = {
      recent: "recent",
      featured: "featured",
      popular: "popular",
    };
    const path = pathMap[category] || "recent";
    const url = `https://asciinema.org/explore/recordings/${path}`;
    const html = await fetchTextWithCorsFallback(url);
    const clips = extractAsciinemaClipsFromHtml(html);
    if (!clips.length) {
      throw new Error("No recordings found in Asciinema response.");
    }
    return clips.slice(0, 60);
  };

  const previewAsciinemaClip = async (clip) => {
    if (!clip?.castUrl) return;
    const reqId = asciinemaPreviewReqRef.current + 1;
    asciinemaPreviewReqRef.current = reqId;
    setAsciinemaSelectedClipId(clip.id);
    setAsciinemaPreviewLoading(true);
    try {
      const text = await fetchTextWithCorsFallback(clip.castUrl);
      if (reqId !== asciinemaPreviewReqRef.current) return;
      const source = parseSourceText(`${clip.id}.cast`, text);
      setAsciinemaPreviewSource(source);
      setAsciinemaPreviewTime(firstVisiblePreviewTime(source.outputEvents, source.duration));
    } catch {
      if (reqId !== asciinemaPreviewReqRef.current) return;
      mutate((m) => {
        m.status = "Could not preview selected Asciinema clip. Try another clip or Import URL.";
      }, { record: false });
    } finally {
      if (reqId === asciinemaPreviewReqRef.current) setAsciinemaPreviewLoading(false);
    }
  };

  const importAsciinemaClip = async (clip) => {
    if (!clip?.castUrl) return;
    try {
      const text = await fetchTextWithCorsFallback(clip.castUrl);
      const source = parseSourceText(`${clip.id}.cast`, text);
      addSourcesToModel([source], false);
      mutate((m) => {
        m.status = `Imported ${clip.id} into local files.`;
      }, { record: false });
    } catch (error) {
      mutate((m) => {
        m.status = `Import failed: ${error.message}`;
      }, { record: false });
    }
  };

  const importAsciinemaByUrl = async () => {
    const raw = window.prompt("Enter Asciinema recording URL or .cast URL:");
    if (!raw) return;
    const trimmed = raw.trim();
    const m = trimmed.match(/asciinema\.org\/a\/([A-Za-z0-9_-]+)/i);
    const castUrl = trimmed.endsWith(".cast")
      ? trimmed
      : m ? `https://asciinema.org/a/${m[1]}.cast` : trimmed;
    await importAsciinemaClip({
      id: m?.[1] || "remote",
      castUrl,
    });
  };

  useEffect(() => {
    if (browserTab !== "asciinema") return;
    let cancelled = false;
    setAsciinemaLoading(true);
    setAsciinemaError("");
    fetchAsciinemaClips(asciinemaCategory)
      .then((clips) => {
        if (cancelled) return;
        setAsciinemaClips(clips);
      })
      .catch((error) => {
        if (cancelled) return;
        setAsciinemaError(
          `${error.message}. If this is a CORS block, import by URL manually.`,
        );
        setAsciinemaClips([]);
      })
      .finally(() => {
        if (!cancelled) setAsciinemaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [browserTab, asciinemaCategory, asciinemaRefreshTick]);

  const updatePanel = (id, layout, mode = "move") => {
    const model = modelRef.current;
    const snapped = snapLayoutToMagnet(id, layout, mode, model.panels, boardRect);
    model.panels = {
      ...model.panels,
      [id]: snapped,
    };
    forceRender();
  };

  const focusPanel = (id) => {
    const model = modelRef.current;
    if (!model.panels) return;
    const maxZ = Math.max(...Object.values(model.panels).map((panel) => panel.z || 0));
    model.panels = {
      ...model.panels,
      [id]: { ...model.panels[id], z: maxZ + 1 },
    };
    forceRender();
  };

  const resetLayout = () => {
    const model = modelRef.current;
    model.panels = defaultPanels(boardRect);
    try {
      window.localStorage.removeItem(LAYOUT_STORAGE_KEY);
      model.status = "Layout reset to defaults.";
    } catch {
      model.status = "Layout reset (storage unavailable).";
    }
    forceRender();
  };

  const saveLayout = () => {
    const model = modelRef.current;
    if (!model.panels) return;
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(model.panels));
      model.status = "Layout saved.";
    } catch {
      model.status = "Could not save layout in browser storage.";
    }
    forceRender();
  };

  const exportCast = () => {
    const edited = buildEditedCast(modelRef.current);

    const payload = JSON.stringify(edited, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const defaultName = "edited.asciicast.json";
    const saveWithDownload = (name) => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name || defaultName;
      anchor.click();
      URL.revokeObjectURL(url);
    };

    const saveAs = async () => {
      try {
        if ("showSaveFilePicker" in window) {
          const handle = await window.showSaveFilePicker({
            suggestedName: defaultName,
            types: [
              {
                description: "Asciicast JSON",
                accept: { "application/json": [".json", ".cast", ".asciicast"] },
              },
            ],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          modelRef.current.status = "Cast exported.";
          forceRender();
          return;
        }

        const name = window.prompt("Save as filename:", defaultName);
        if (!name) return;
        saveWithDownload(name);
        modelRef.current.status = `Cast exported as ${name}.`;
        forceRender();
      } catch (error) {
        if (error?.name === "AbortError") return;
        saveWithDownload(defaultName);
        modelRef.current.status = "Could not open Save As dialog; downloaded default file.";
        forceRender();
      }
    };

    void saveAs();
  };

  const hideContextMenu = () => {
    const model = modelRef.current;
    if (!model.contextMenu.visible) return;
    model.contextMenu = { visible: false, x: 0, y: 0, clipId: null };
  };

  const setPlayheadFromClientX = (clientX) => {
    const track = timelineTrackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    mutate(
      (m) => {
        const pct = clamp((clientX - rect.left) / rect.width, 0, 1);
        m.playheadTime = m.composedDuration * pct;
      },
      { record: false },
    );
  };

  const beginPlayheadDrag = (downEvent) => {
    downEvent.preventDefault();
    downEvent.stopPropagation();
    hideContextMenu();
    setPlayheadFromClientX(downEvent.clientX);

    const onMove = (moveEvent) => {
      setPlayheadFromClientX(moveEvent.clientX);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const ensurePreviewPopupSkeleton = (win) => {
    if (!win || win.closed) return;
    win.document.title = "Ascii Edit Preview";
    if (win.document.getElementById("popup-preview-root")) return;
    win.document.documentElement.style.margin = "0";
    win.document.documentElement.style.height = "100%";
    win.document.body.style.margin = "0";
    win.document.body.style.height = "100%";
    win.document.body.innerHTML = `
      <style>
        :root { color-scheme: light dark; }
        body {
          font-family: "IBM Plex Mono", Menlo, monospace;
          background: #141922;
          color: #e7edf3;
          display: grid;
          grid-template-rows: auto 1fr;
          height: 100%;
        }
        .bar {
          display: flex;
          justify-content: space-between;
          gap: 8px;
          padding: 8px 10px;
          background: #1d2531;
          border-bottom: 1px solid #2f3d50;
          font-size: 12px;
        }
        .terminal {
          margin: 0;
          white-space: pre;
          overflow: auto;
          padding: 10px;
          font-size: 13px;
          line-height: 1.2;
          height: 100%;
          box-sizing: border-box;
        }
      </style>
      <div class="bar">
        <span id="popup-time">00:00.000</span>
        <span>Pop-out Preview</span>
      </div>
      <pre id="popup-preview-root" class="terminal"></pre>
    `;
  };

  const openPreviewPopup = () => {
    const existing = previewPopupRef.current;
    if (existing && !existing.closed) {
      existing.focus();
      setPreviewPoppedOut(true);
      return;
    }
    const win = window.open("", "ascii-edit-preview", "popup=yes,width=980,height=680");
    if (!win) {
      mutate((m) => {
        m.status = "Popup blocked by browser. Allow popups for this site.";
      }, { record: false });
      return;
    }
    previewPopupRef.current = win;
    ensurePreviewPopupSkeleton(win);
    win.addEventListener("beforeunload", () => {
      previewPopupRef.current = null;
      setPreviewPoppedOut(false);
    });
    setPreviewPoppedOut(true);
  };

  const closePreviewPopup = () => {
    const win = previewPopupRef.current;
    if (win && !win.closed) win.close();
    previewPopupRef.current = null;
    setPreviewPoppedOut(false);
  };

  useEffect(() => {
    const win = previewPopupRef.current;
    if (!win || win.closed) return;
    ensurePreviewPopupSkeleton(win);
    const terminal = win.document.getElementById("popup-preview-root");
    const time = win.document.getElementById("popup-time");
    if (terminal) {
      terminal.style.color = previewFrame.theme.fg || "#e7edf3";
      terminal.style.backgroundColor = previewFrame.theme.bg || "#141922";
      terminal.innerHTML = previewFrame.html || "";
    }
    const popupTime = browserTab === "asciinema" && asciinemaPreviewSource?.header
      ? asciinemaPreviewTime
      : model.playheadTime;
    if (time) time.textContent = fmtTime(popupTime);
  }, [previewFrame.html, previewFrame.theme.bg, previewFrame.theme.fg, model.playheadTime, browserTab, asciinemaPreviewSource, asciinemaPreviewTime]);

  useEffect(() => {
    return () => {
      const win = previewPopupRef.current;
      if (win && !win.closed) win.close();
      previewPopupRef.current = null;
    };
  }, []);

  const panelLayouts = model.panels || defaultPanels(boardRect);
  const timelineHeight = 165;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-logo" aria-hidden="true">
            <svg viewBox="0 0 64 64" width="38" height="38">
              <rect x="6" y="8" width="52" height="44" rx="8" fill="#2e668f" stroke="#1b3d59" strokeWidth="2" />
              <path d="M20 8l7 8h-9zM44 8l9 8h-9z" fill="#2e668f" stroke="#1b3d59" strokeWidth="2" />
              <rect x="14" y="16" width="36" height="24" rx="4" fill="#f3fbff" />
              <circle cx="25" cy="27" r="2.7" fill="#24384a" />
              <circle cx="39" cy="27" r="2.7" fill="#24384a" />
              <path d="M26 34c2 3 10 3 12 0" fill="none" stroke="#24384a" strokeWidth="2" strokeLinecap="round" />
              <rect x="24" y="41" width="16" height="3" rx="1.5" fill="#ffd28e" />
            </svg>
          </div>
          <h1>
            <span>Ascii Edit</span>
            <small>By Michael Chenetz</small>
          </h1>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => {
            const model = modelRef.current;
            if (model.historyIndex <= 0) return;
            model.historyIndex -= 1;
            applySnapshot(model, model.history[model.historyIndex]);
            forceRender();
          }} disabled={!canUndo}>Undo</button>
          <button className="btn" onClick={saveLayout}>Save Layout</button>
          <button className="btn" onClick={resetLayout}>Reset Layout</button>
          <button className="btn" onClick={exportCast} disabled={!canEdit}>Export Edited Cast</button>
          <div className="settings-wrap">
            <button
              className="gear-btn"
              onClick={() => setSettingsOpen((open) => !open)}
              aria-label="Open settings"
              title="Settings"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path fill="currentColor" d="M19.14 12.94a7.96 7.96 0 0 0 .05-.94 7.96 7.96 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.2 7.2 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.96 7.96 0 0 0-.05.94c0 .32.02.63.05.94L2.82 14.52a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.04.71 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.59-.23 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z" />
              </svg>
            </button>
            {settingsOpen && (
              <div className="settings-menu">
                <div className="settings-title">Keyboard Shortcuts</div>
                {SHORTCUT_FIELDS.map((field) => (
                  <div key={field.key} className="settings-row">
                    <span>{field.label}</span>
                    <input
                      value={model.settings?.shortcuts?.[field.key] || DEFAULT_SHORTCUTS[field.key]}
                      readOnly
                      onKeyDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        updateShortcut(field.key, eventToShortcut(event));
                      }}
                      title="Press a key combo"
                    />
                  </div>
                ))}
                <div className="settings-actions">
                  <button onClick={resetShortcuts}>Reset</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="status-row">{model.status}</div>

      <main className="workspace" ref={workspaceRef}>
        <FloatingPanel
          id="browser"
          title="Project Browser"
          layout={panelLayouts.browser}
          boardRect={boardRect}
          onLayoutChange={updatePanel}
          onFocus={focusPanel}
          minWidth={260}
          minHeight={260}
          controls={<div className="hint">{model.projectName}</div>}
        >
          <div
            className={`browser-drop-zone ${browserDropActive ? "active" : ""}`}
            onDragEnter={(event) => {
              if (!event.dataTransfer?.types?.includes("Files")) return;
              event.preventDefault();
              setBrowserDropActive(true);
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer?.types?.includes("Files")) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              if (!browserDropActive) setBrowserDropActive(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setBrowserDropActive(false);
              }
            }}
            onDrop={(event) => {
              if (!event.dataTransfer?.files?.length) return;
              event.preventDefault();
              setBrowserDropActive(false);
              void loadSourceFiles(Array.from(event.dataTransfer.files), false);
            }}
          >
            <div className="browser-tabs">
              <button
                className={`tab-btn ${browserTab === "project" ? "active" : ""}`}
                onClick={() => setBrowserTab("project")}
              >
                Project
              </button>
              <button
                className={`tab-btn ${browserTab === "projects" ? "active" : ""}`}
                onClick={() => setBrowserTab("projects")}
              >
                Projects
              </button>
              <button
                className={`tab-btn ${browserTab === "asciinema" ? "active" : ""}`}
                onClick={() => setBrowserTab("asciinema")}
              >
                Asciinema
              </button>
            </div>
            {browserTab === "project" ? (
              <>
                <div className="browser-toolbar">
                  <label className="btn">
                    Add Cast Files
                    <input type="file" accept=".json,.cast,.asciicast" multiple hidden onChange={(event) => onLoadFiles(event, false)} />
                  </label>
                  <button onClick={saveCurrentProject}>Save Project</button>
                  {selectedSource && (
                    <button onClick={() => addSourceToTimeline(selectedSource.id)}>Add In/Out to Timeline</button>
                  )}
                </div>
                <div className="source-list">
                {model.sources.length === 0 ? (
                  <div className="browser-empty-state">
                    <div className="browser-empty-icon" aria-hidden="true">.cast</div>
                    <div className="browser-empty-title">Drag Cast Files Here</div>
                    <div className="browser-empty-text">
                      Drop `.cast`, `.asciicast`, or `.json` files from your OS file browser.
                    </div>
                    <div className="browser-empty-text">
                      You can also use the “Add Cast Files” button above.
                    </div>
                  </div>
                ) : model.sources.map((source) => {
              const preview = browserPreviewMap.get(source.id);
              const duration = Math.max(source.duration, 0.01);
              const scrubPct = clamp(source.scrubTime / duration, 0, 1) * 100;
              return (
                <div
                  key={source.id}
                  className={`source-card ${model.selectedSourceId === source.id ? "selected" : ""}`}
                  draggable
                  onClick={() =>
                    mutate((m) => {
                      m.selectedSourceId = source.id;
                    }, { record: false })
                  }
                  onDragStart={(event) => {
                    model.dragSourceId = source.id;
                    model.selectedSourceId = source.id;
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData("text/plain", source.id);
                  }}
                  onDragEnd={() => {
                    model.dragSourceId = null;
                    forceRender();
                  }}
                >
                  <div className="source-card-head">
                    <span className="source-name" title={source.name}>{source.name}</span>
                    <span className="source-duration">{fmtTime(source.duration)}</span>
                  </div>
                  <div className="source-preview-wrap">
                    <div
                      className="source-scrub-hitbox"
                      onPointerDown={(downEvent) => {
                        downEvent.preventDefault();
                        downEvent.stopPropagation();
                        const rect = downEvent.currentTarget.getBoundingClientRect();
                        const applyFromX = (clientX) => {
                          mutate((m) => {
                            const target = getSourceById(m, source.id);
                            if (!target) return;
                            const pct = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
                            target.scrubTime = target.duration * pct;
                          }, { record: false });
                        };
                        applyFromX(downEvent.clientX);
                        const onMove = (moveEvent) => applyFromX(moveEvent.clientX);
                        const onUp = () => {
                          window.removeEventListener("pointermove", onMove);
                          window.removeEventListener("pointerup", onUp);
                        };
                        window.addEventListener("pointermove", onMove);
                        window.addEventListener("pointerup", onUp);
                      }}
                    />
                    <pre
                      className="source-preview"
                      style={{
                        color: preview?.theme?.fg || "#ddd",
                        backgroundColor: preview?.theme?.bg || "#111",
                      }}
                      dangerouslySetInnerHTML={{ __html: preview?.html || "" }}
                    />
                    <div className="source-playhead" style={{ left: `${scrubPct}%` }} />
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1000"
                    value={Math.floor(clamp(source.scrubTime / duration, 0, 1) * 1000)}
                    onChange={(event) =>
                      mutate((m) => {
                        const target = getSourceById(m, source.id);
                        if (!target) return;
                        target.scrubTime = (Number(event.target.value) / 1000) * target.duration;
                      }, { record: false })
                    }
                    onClick={(event) => event.stopPropagation()}
                  />
                  <div className="source-range-labels">
                    <span>In {fmtTime(source.inPoint)}</span>
                    <span>Out {fmtTime(source.outPoint)}</span>
                  </div>
                  <div className="source-range">
                    <input
                      type="range"
                      min="0"
                      max="1000"
                      value={Math.floor(clamp(source.inPoint / duration, 0, 1) * 1000)}
                      onChange={(event) =>
                        mutate((m) => {
                          const target = getSourceById(m, source.id);
                          if (!target) return;
                          const next = (Number(event.target.value) / 1000) * target.duration;
                          target.inPoint = clamp(next, 0, Math.max(0, target.outPoint - 0.01));
                        }, { record: false })
                      }
                      onClick={(event) => event.stopPropagation()}
                    />
                    <input
                      type="range"
                      min="0"
                      max="1000"
                      value={Math.floor(clamp(source.outPoint / duration, 0, 1) * 1000)}
                      onChange={(event) =>
                        mutate((m) => {
                          const target = getSourceById(m, source.id);
                          if (!target) return;
                          const next = (Number(event.target.value) / 1000) * target.duration;
                          target.outPoint = clamp(next, Math.min(target.duration, target.inPoint + 0.01), target.duration);
                        }, { record: false })
                      }
                      onClick={(event) => event.stopPropagation()}
                    />
                  </div>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      addSourceToTimeline(source.id);
                    }}
                  >
                    Add Clip
                  </button>
                </div>
              );
            })}
                </div>
              </>
            ) : browserTab === "projects" ? (
              <>
                <div className="browser-toolbar">
                  <button onClick={saveCurrentProject}>Save Current Project</button>
                </div>
                <div className="source-list">
                  {savedProjects.length === 0 ? (
                    <div className="hint">No saved projects yet.</div>
                  ) : savedProjects
                    .slice()
                    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
                    .map((project) => (
                      <div key={project.id} className="project-card">
                        <div className="project-card-head">
                          <span className="source-name" title={project.name}>{project.name}</span>
                          <span className="source-duration">
                            {project.updatedAt ? new Date(project.updatedAt).toLocaleString() : ""}
                          </span>
                        </div>
                        <div className="project-card-meta">
                          {(project.state?.sources?.length || 0)} files
                          {" • "}
                          {(project.state?.segments?.length || 0)} clips
                        </div>
                        <div className="remote-actions">
                          <button className="icon-action" onClick={() => loadSavedProject(project.id)} title="Load">
                            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                              <path fill="currentColor" d="M19 20H5a2 2 0 0 1-2-2V6h2v12h14V6h2v12a2 2 0 0 1-2 2zM12 3l5 5h-3v5h-4V8H7l5-5z" />
                            </svg>
                            <span className="sr-only">Load Project</span>
                          </button>
                          <button className="icon-action" onClick={() => deleteSavedProject(project.id)} title="Delete">
                            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                              <path fill="currentColor" d="M6 7h12l-1 14H7L6 7zm3-4h6l1 2h4v2H4V5h4l1-2z" />
                            </svg>
                            <span className="sr-only">Delete Project</span>
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              </>
            ) : (
              <>
                <div className="browser-toolbar">
                  <label>
                    Category
                    <select
                      value={asciinemaCategory}
                      onChange={(event) => setAsciinemaCategory(event.target.value)}
                    >
                      <option value="recent">Recent</option>
                      <option value="featured">Featured</option>
                      <option value="popular">Popular</option>
                    </select>
                  </label>
                  <button onClick={() => setAsciinemaRefreshTick((value) => value + 1)}>Refresh</button>
                  <button onClick={() => { void importAsciinemaByUrl(); }}>Import URL</button>
                </div>
                {asciinemaPreviewLoading && <div className="hint">Loading selected clip preview...</div>}
                <div className="source-list">
                  {asciinemaLoading && <div className="hint">Loading Asciinema recordings...</div>}
                  {!asciinemaLoading && asciinemaError && <div className="hint">{asciinemaError}</div>}
                  {!asciinemaLoading && !asciinemaError && asciinemaClips.length === 0 && (
                    <div className="hint">No clips found.</div>
                  )}
                  {!asciinemaLoading && asciinemaClips.map((clip) => (
                    <div
                      key={clip.id}
                      className={`remote-card ${asciinemaSelectedClipId === clip.id ? "selected" : ""}`}
                      onClick={() => { void previewAsciinemaClip(clip); }}
                    >
                      <img
                        className="remote-thumb"
                        src={clip.thumbnailUrl}
                        alt={clip.title}
                        loading="lazy"
                        onError={(event) => {
                          event.currentTarget.style.display = "none";
                        }}
                      />
                      <div className="remote-card-head">
                        <span className="source-name" title={clip.title}>{clip.title}</span>
                        <span className="source-duration">{clip.id}</span>
                      </div>
                      {clip.subtitle ? <div className="remote-subtitle">{clip.subtitle}</div> : null}
                      {clip.tags?.length ? (
                        <div className="remote-tags">
                          {clip.tags.map((tag) => (
                            <span key={`${clip.id}-${tag}`} className="remote-tag">{tag}</span>
                          ))}
                        </div>
                      ) : null}
                      <div className="remote-actions">
                        <a
                          href={clip.url}
                          target="_blank"
                          rel="noreferrer"
                          className="icon-action"
                          aria-label="Open clip on Asciinema"
                          title="Open"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                            <path fill="currentColor" d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3z" />
                            <path fill="currentColor" d="M5 5h6v2H7v10h10v-4h2v6H5V5z" />
                          </svg>
                          <span className="sr-only">Open</span>
                        </a>
                        <button
                          className="icon-action"
                          onClick={(event) => {
                            event.stopPropagation();
                            void importAsciinemaClip(clip);
                          }}
                          aria-label="Import clip"
                          title="Import"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                            <path fill="currentColor" d="M11 3h2v9h3l-4 4-4-4h3V3z" />
                            <path fill="currentColor" d="M5 18h14v3H5v-3z" />
                          </svg>
                          <span className="sr-only">Import</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </FloatingPanel>

        <FloatingPanel
          id="preview"
          title="Preview"
          layout={panelLayouts.preview}
          boardRect={boardRect}
          onLayoutChange={updatePanel}
          onFocus={focusPanel}
          minWidth={360}
          minHeight={260}
          controls={<div className="hint">Interactive preview editor</div>}
        >
          <div className="preview-toolbar">
            <button
              onClick={() => {
                const model = modelRef.current;
                model.playing = !model.playing;
                model.contextMenu = { visible: false, x: 0, y: 0, clipId: null };
                if (model.playing) startPlayback();
                else stopPlayback();
                forceRender();
              }}
              disabled={!canEdit}
            >
              {model.playing ? "Pause" : "Play"}
            </button>
            <button
              onClick={() =>
                mutate(
                  (m) => {
                    m.playheadTime = 0;
                    m.playing = false;
                  },
                  { record: false },
                )
              }
              disabled={!canEdit}
            >
              Rewind
            </button>
            <label>
              Speed
              <select
                value={String(model.speed)}
                onChange={(event) =>
                  mutate(
                    (m) => {
                      m.speed = Number(event.target.value) || 1;
                    },
                    { record: false },
                  )
                }
                disabled={!canEdit}
              >
                <option value="0.5">0.5x</option>
                <option value="1">1x</option>
                <option value="1.5">1.5x</option>
                <option value="2">2x</option>
              </select>
            </label>
            <button onClick={previewPoppedOut ? closePreviewPopup : openPreviewPopup}>
              {previewPoppedOut ? "Dock Preview" : "Pop Out Preview"}
            </button>
          </div>

          <pre
            className="terminal"
            style={{
              color: previewFrame.theme.fg,
              backgroundColor: previewFrame.theme.bg,
            }}
            dangerouslySetInnerHTML={{ __html: previewFrame.html }}
          />

          <div className="seek-row">
            <input
              type="range"
              min="0"
              max="1000"
              value={previewDuration === 0 ? 0 : Math.floor((effectivePreviewTime / previewDuration) * 1000)}
              onChange={(event) => {
                const pct = Number(event.target.value) / 1000;
                if (usingAsciinemaPreview) {
                  setAsciinemaPreviewTime(previewDuration * pct);
                  return;
                }
                mutate((m) => {
                  m.playheadTime = previewDuration * pct;
                }, { record: false });
              }}
              disabled={previewDuration <= 0}
            />
            <div>{fmtTime(effectivePreviewTime)} / {fmtTime(previewDuration)}</div>
          </div>
        </FloatingPanel>

        <FloatingPanel
          id="timeline"
          title="Timeline"
          layout={panelLayouts.timeline}
          boardRect={boardRect}
          onLayoutChange={updatePanel}
          onFocus={focusPanel}
          minWidth={420}
          minHeight={220}
          controls={<div className="hint">Right-click clips for cut/copy/paste, scale. Cmd/Ctrl+Click for multi-select.</div>}
        >
          <div className="timeline-ruler">
            {(() => {
              const duration = Math.max(model.composedDuration, 0.1);
              const majorStep = duration <= 10 ? 1 : duration <= 60 ? 5 : 10;
              const ticks = [];
              for (let t = 0; t <= duration + 0.001; t += majorStep / 2) {
                const left = (t / duration) * 100;
                const major = Math.round((t / majorStep) * 1000) % 1000 === 0;
                ticks.push(
                  <div
                    key={`tick-${t.toFixed(3)}`}
                    className={`timeline-tick ${major ? "major" : "minor"}`}
                    style={{ left: `${left}%` }}
                  >
                    {major && (
                      <button
                        className="timeline-tick-label"
                        onClick={(event) => {
                          event.stopPropagation();
                          mutate(
                            (m) => {
                              m.playheadTime = clamp(t, 0, m.composedDuration);
                            },
                            { record: false },
                          );
                        }}
                      >
                        {fmtTime(t)}
                      </button>
                    )}
                  </div>,
                );
              }
              return ticks;
            })()}
            <div
              className="timeline-now-label"
              style={{
                left: `${model.composedDuration <= 0 ? 0 : (model.playheadTime / model.composedDuration) * 100}%`,
              }}
            >
              {fmtTime(model.playheadTime)}
            </div>
            <button
              className="timeline-ruler-hitbox"
              onPointerDown={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const pct = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
                mutate(
                  (m) => {
                    m.playheadTime = m.composedDuration * pct;
                  },
                  { record: false },
                );
              }}
              aria-label="Set timeline playhead"
            />
          </div>

          <div
            className="timeline-track"
            ref={timelineTrackRef}
            style={{ height: `${timelineHeight}px` }}
            onDragOver={(event) => {
              if (!model.dragSourceId) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(event) => {
              if (!model.dragSourceId) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              const pct = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
              const targetTime = model.composedDuration * pct;
              const sourceId = model.dragSourceId;
              model.dragSourceId = null;
              addSourceToTimeline(sourceId, targetTime);
            }}
            onPointerDown={(event) => {
              if (event.target.closest(".clip") || event.target.closest(".playhead")) return;
              hideContextMenu();
              setPlayheadFromClientX(event.clientX);
            }}
            onClick={() => {
              if (!model.contextMenu.visible) return;
              model.contextMenu = { visible: false, x: 0, y: 0, clipId: null };
              forceRender();
            }}
          >
            {model.segments.map((seg, index) => {
              const duration = Math.max(model.composedDuration, 0.001);
              const clipDuration = segmentLength(seg);
              const startTime = clipStartInTimeline(model.segments, index);
              const leftPct = (startTime / duration) * 100;
              const widthPct = (clipDuration / duration) * 100;
              const selected = model.selectedClipId === seg.id;
              const multiSelected = model.selectedClipIds.includes(seg.id);

              const trim = (edge, downEvent) => {
                downEvent.preventDefault();
                downEvent.stopPropagation();

                const startX = downEvent.clientX;
                const original = { ...seg };
                const trackWidth = timelineTrackRef.current?.clientWidth || 1;
                let changed = false;

                const onMove = (moveEvent) => {
                  const delta = ((moveEvent.clientX - startX) / trackWidth) * duration;
                  if (edge === "left") {
                    const next = clamp(original.start + delta, 0, seg.end - 0.01);
                    if (Math.abs(next - seg.start) > 0.00001) {
                      seg.start = next;
                      seg.timelineDuration = sourceLength(seg);
                      changed = true;
                    }
                  } else {
                    const sourceLimit = getSegmentSourceLimit(model, seg);
                    const next = clamp(original.end + delta, seg.start + 0.01, sourceLimit);
                    if (Math.abs(next - seg.end) > 0.00001) {
                      seg.end = next;
                      seg.timelineDuration = sourceLength(seg);
                      changed = true;
                    }
                  }

                  if (changed) {
                    rebuildComposedDuration(model);
                    model.playheadTime = clamp(model.playheadTime, 0, model.composedDuration);
                    forceRender();
                  }
                };

                const onUp = () => {
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                  if (changed) recordHistory();
                };

                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
              };

              return (
                <div
                  key={seg.id}
                  className={`clip ${selected ? "selected" : ""} ${multiSelected ? "multi-selected" : ""}`}
                  style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 1.5)}%` }}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (event.metaKey || event.ctrlKey) {
                      if (model.selectedClipIds.includes(seg.id)) {
                        model.selectedClipIds = model.selectedClipIds.filter((id) => id !== seg.id);
                        model.selectedClipId = model.selectedClipIds[model.selectedClipIds.length - 1] || null;
                      } else {
                        model.selectedClipIds = [...model.selectedClipIds, seg.id];
                        model.selectedClipId = seg.id;
                      }
                    } else {
                      model.selectedClipIds = [seg.id];
                      model.selectedClipId = seg.id;
                    }
                    if (seg.sourceId) model.selectedSourceId = seg.sourceId;
                    setAsciinemaPreviewSource(null);
                    setAsciinemaSelectedClipId("");
                    forceRender();
                  }}
                  onContextMenu={(event) => openMenu(event, seg.id)}
                  onDragOver={(event) => {
                    if (!model.dragClipId || model.dragClipId === seg.id) return;
                    event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (!model.dragClipId || model.dragClipId === seg.id) return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    const placeAfter = event.clientX > rect.left + rect.width / 2;
                    mutate((m) => {
                      moveSegment(m, model.dragClipId, seg.id, placeAfter);
                      m.dragClipId = null;
                      m.selectedClipIds = m.selectedClipId ? [m.selectedClipId] : [];
                    });
                  }}
                >
                  <button className="handle" onPointerDown={(event) => trim("left", event)} aria-label="Trim clip left" />
                  <div
                    className="clip-body"
                    draggable
                    onDragStart={(event) => {
                      model.dragClipId = seg.id;
                      model.selectedClipId = seg.id;
                      model.selectedClipIds = [seg.id];
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", seg.id);
                    }}
                    onDragEnd={() => {
                      model.dragClipId = null;
                      forceRender();
                    }}
                  >
                    <div className="clip-label">{seg.label} ({fmtTime(clipDuration)})</div>
                    <div className="clip-preview">{clipPreviewMap.get(seg.id) || "(no output)"}</div>
                    <div className="clip-marker-lane">
                      {(clipTextMarkers.get(seg.id) || []).map((marker, markerIndex) => (
                        <span
                          key={`${seg.id}-${markerIndex}-${marker.t.toFixed(3)}`}
                          className="clip-marker"
                          style={{ left: `${clamp(marker.t * 100, 0, 100)}%` }}
                          title={marker.text}
                        >
                          {marker.text}
                        </span>
                      ))}
                    </div>
                  </div>
                  <button className="handle" onPointerDown={(event) => trim("right", event)} aria-label="Trim clip right" />
                </div>
              );
            })}

            <div
              className="playhead"
              style={{ left: `${model.composedDuration <= 0 ? 0 : (model.playheadTime / model.composedDuration) * 100}%` }}
              onPointerDown={beginPlayheadDrag}
            />
          </div>

          <div className="timeline-actions">
            <button
              className="icon-action"
              onClick={() => mutate((m) => splitAtPlayhead(m))}
              disabled={!canEdit}
              title="Split"
              aria-label="Split"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path fill="currentColor" d="M4 6h6v3H4V6zm10 0h6v3h-6V6zM4 15h6v3H4v-3zm10 0h6v3h-6v-3zM11 3h2v18h-2V3z" />
              </svg>
              <span className="sr-only">Split</span>
            </button>
            <button
              className="icon-action"
              onClick={healSelectedClips}
              disabled={!canHeal}
              title="Heal"
              aria-label="Heal"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path fill="currentColor" d="M3 6h8v12H3V6zm10 0h8v12h-8V6zM10 10h4v4h-4v-4z" />
              </svg>
              <span className="sr-only">Heal</span>
            </button>
          </div>

          <div className="clip-inspector">
            {!selectedClip ? (
              <div>Select a clip to edit details.</div>
            ) : (
              <div className="inspector-row">
                <label>
                  Label
                  <input
                    value={selectedClip.label}
                    onChange={(event) => mutate((m) => {
                      const clip = m.segments.find((s) => s.id === selectedClip.id);
                      if (clip) clip.label = event.target.value || "Clip";
                    })}
                  />
                </label>
                <label>
                  Start
                  <input
                    type="number"
                    step="0.01"
                    value={selectedClip.start.toFixed(3)}
                    onChange={(event) => mutate((m) => {
                      const clip = m.segments.find((s) => s.id === selectedClip.id);
                      if (!clip) return;
                      clip.start = clamp(Number(event.target.value), 0, clip.end - 0.01);
                      clip.timelineDuration = sourceLength(clip);
                    })}
                  />
                </label>
                <label>
                  End
                  <input
                    type="number"
                    step="0.01"
                    value={selectedClip.end.toFixed(3)}
                    onChange={(event) => mutate((m) => {
                      const clip = m.segments.find((s) => s.id === selectedClip.id);
                      if (!clip) return;
                      clip.end = clamp(Number(event.target.value), clip.start + 0.01, getSegmentSourceLimit(m, clip));
                      clip.timelineDuration = sourceLength(clip);
                    })}
                  />
                </label>
                <button
                  onClick={() => mutate((m) => {
                    if (m.segments.length <= 1) return;
                    const idx = m.segments.findIndex((s) => s.id === selectedClip.id);
                    if (idx === -1) return;
                    m.segments.splice(idx, 1);
                    m.selectedClipId = m.segments[Math.max(0, idx - 1)]?.id ?? null;
                    m.selectedClipIds = m.selectedClipId ? [m.selectedClipId] : [];
                  })}
                  disabled={model.segments.length <= 1}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </FloatingPanel>

        {model.contextMenu.visible && (
          <div
            className="context-menu"
            style={{ left: `${model.contextMenu.x}px`, top: `${model.contextMenu.y}px` }}
          >
            <button onClick={() => applyMenuAction("cut")} disabled={model.segments.length <= 1}>Cut</button>
            <button onClick={() => applyMenuAction("copy")}>Copy</button>
            <button onClick={() => applyMenuAction("paste-before")} disabled={!model.clipboardSegment}>Paste Before</button>
            <button onClick={() => applyMenuAction("paste-after")} disabled={!model.clipboardSegment}>Paste After</button>
            <button onClick={() => applyMenuAction("scale-clip")}>Scale Time (Clip)</button>
            <button onClick={() => applyMenuAction("scale-selected")} disabled={model.selectedClipIds.length < 2}>Scale Time (Selected)</button>
            <button onClick={() => applyMenuAction("delete")} disabled={model.segments.length <= 1}>Delete</button>
          </div>
        )}
      </main>
    </div>
  );
}
