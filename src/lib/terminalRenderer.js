const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const DEFAULT_ANSI_PALETTE = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];

function escapeHtml(text) {
  return text.replace(/[&<>\"]/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return "&quot;";
  });
}

function toHexByte(value) {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}

function rgbToHex(r, g, b) {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

function parsePalette(paletteText) {
  if (typeof paletteText !== "string") return DEFAULT_ANSI_PALETTE.slice();
  const colors = paletteText
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.startsWith("#") ? part : `#${part}`));
  return colors.length >= 16 ? colors.slice(0, 16) : DEFAULT_ANSI_PALETTE.slice();
}

export function getTerminalTheme(header) {
  const theme = header?.term?.theme || header?.theme || null;
  return {
    fg: theme?.fg || "#f5f5f5",
    bg: theme?.bg || "#111015",
    palette: parsePalette(theme?.palette),
  };
}

function ansi256ToHex(index, palette) {
  const value = clamp(Number(index) || 0, 0, 255);
  if (value < 16) return palette[value];
  if (value >= 232) {
    const level = 8 + (value - 232) * 10;
    return rgbToHex(level, level, level);
  }
  const cube = value - 16;
  const r = Math.floor(cube / 36);
  const g = Math.floor((cube % 36) / 6);
  const b = cube % 6;
  const step = [0, 95, 135, 175, 215, 255];
  return rgbToHex(step[r], step[g], step[b]);
}

function cellStyleKey(style) {
  style ||= {};
  return `${style.fg || ""}|${style.bg || ""}|${style.bold ? 1 : 0}|${style.italic ? 1 : 0}|${style.underline ? 1 : 0}|${style.inverse ? 1 : 0}|${style.strike ? 1 : 0}|${style.dim ? 1 : 0}`;
}

function cellStyleToCss(style) {
  style ||= {};
  let fg = style.fg;
  let bg = style.bg;
  if (style.inverse) {
    [fg, bg] = [bg, fg];
  }
  const css = [];
  if (fg) css.push(`color:${fg}`);
  if (bg) css.push(`background-color:${bg}`);
  if (style.bold) css.push("font-weight:700");
  if (style.italic) css.push("font-style:italic");
  if (style.underline || style.strike) {
    const parts = [];
    if (style.underline) parts.push("underline");
    if (style.strike) parts.push("line-through");
    css.push(`text-decoration:${parts.join(" ")}`);
  }
  if (style.dim) css.push("opacity:0.75");
  return css.join(";");
}

export function renderTerminalToHtml(rows, cols, eventsUntilTime, theme) {
  const makeDefaultStyle = () => ({
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
    strike: false,
  });

  let currentStyle = makeDefaultStyle();
  const makeBlankCell = () => ({ ch: " ", style: { ...currentStyle } });
  let screen = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ ch: " ", style: makeDefaultStyle() })),
  );

  let row = 0;
  let col = 0;

  const ensureBounds = () => {
    row = clamp(row, 0, rows - 1);
    col = clamp(col, 0, cols - 1);
  };

  const writeChar = (ch) => {
    if (ch === "\n") {
      row += 1;
      col = 0;
      if (row >= rows) {
        screen.shift();
        screen.push(Array.from({ length: cols }, () => makeBlankCell()));
        row = rows - 1;
      }
      return;
    }
    if (ch === "\r") {
      col = 0;
      return;
    }
    if (ch === "\b") {
      col = Math.max(0, col - 1);
      return;
    }
    if (col >= cols) {
      row += 1;
      col = 0;
      if (row >= rows) {
        screen.shift();
        screen.push(Array.from({ length: cols }, () => makeBlankCell()));
        row = rows - 1;
      }
    }
    screen[row][col] = { ch, style: { ...currentStyle } };
    col += 1;
  };

  const eraseInLine = (mode) => {
    if (mode === 0) {
      for (let c = col; c < cols; c += 1) screen[row][c] = makeBlankCell();
    } else if (mode === 1) {
      for (let c = 0; c <= col; c += 1) screen[row][c] = makeBlankCell();
    } else if (mode === 2) {
      for (let c = 0; c < cols; c += 1) screen[row][c] = makeBlankCell();
    }
  };

  const eraseInDisplay = (mode) => {
    if (mode === 2) {
      screen = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => ({ ch: " ", style: makeDefaultStyle() })),
      );
      row = 0;
      col = 0;
      return;
    }
    if (mode === 0) {
      eraseInLine(0);
      for (let r = row + 1; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) screen[r][c] = makeBlankCell();
      }
      return;
    }
    if (mode === 1) {
      eraseInLine(1);
      for (let r = 0; r < row; r += 1) {
        for (let c = 0; c < cols; c += 1) screen[r][c] = makeBlankCell();
      }
    }
  };

  const applySgr = (params) => {
    const values = params.length ? params : [0];
    for (let i = 0; i < values.length; i += 1) {
      const code = values[i] ?? 0;
      if (code === 0) {
        currentStyle = makeDefaultStyle();
      } else if (code === 1) {
        currentStyle.bold = true;
      } else if (code === 2) {
        currentStyle.dim = true;
      } else if (code === 3) {
        currentStyle.italic = true;
      } else if (code === 4) {
        currentStyle.underline = true;
      } else if (code === 7) {
        currentStyle.inverse = true;
      } else if (code === 9) {
        currentStyle.strike = true;
      } else if (code === 22) {
        currentStyle.bold = false;
        currentStyle.dim = false;
      } else if (code === 23) {
        currentStyle.italic = false;
      } else if (code === 24) {
        currentStyle.underline = false;
      } else if (code === 27) {
        currentStyle.inverse = false;
      } else if (code === 29) {
        currentStyle.strike = false;
      } else if (code >= 30 && code <= 37) {
        currentStyle.fg = theme.palette[code - 30];
      } else if (code === 39) {
        currentStyle.fg = null;
      } else if (code >= 40 && code <= 47) {
        currentStyle.bg = theme.palette[code - 40];
      } else if (code === 49) {
        currentStyle.bg = null;
      } else if (code >= 90 && code <= 97) {
        currentStyle.fg = theme.palette[code - 90 + 8];
      } else if (code >= 100 && code <= 107) {
        currentStyle.bg = theme.palette[code - 100 + 8];
      } else if (code === 38 || code === 48) {
        const isFg = code === 38;
        const mode = values[i + 1];
        if (mode === 5 && i + 2 < values.length) {
          const color = ansi256ToHex(values[i + 2], theme.palette);
          if (isFg) currentStyle.fg = color;
          else currentStyle.bg = color;
          i += 2;
        } else if (mode === 2 && i + 4 < values.length) {
          const color = rgbToHex(values[i + 2], values[i + 3], values[i + 4]);
          if (isFg) currentStyle.fg = color;
          else currentStyle.bg = color;
          i += 4;
        }
      }
    }
  };

  const handleEscape = (seq) => {
    if (!seq.startsWith("\u001b[")) return false;
    const body = seq.slice(2);
    const match = body.match(/^([0-9:;<=>?]*)([@-~])$/);
    if (!match) return false;
    const paramText = match[1].replace(/^[<=>?]+/, "");
    const params = paramText.length ? paramText.split(";").map((p) => Number(p) || 0) : [0];
    const code = match[2];

    switch (code) {
      case "H": {
        const r = (params[0] || 1) - 1;
        const c = (params[1] || 1) - 1;
        row = clamp(r, 0, rows - 1);
        col = clamp(c, 0, cols - 1);
        break;
      }
      case "A":
        row -= params[0] || 1;
        ensureBounds();
        break;
      case "B":
        row += params[0] || 1;
        ensureBounds();
        break;
      case "C":
        col += params[0] || 1;
        ensureBounds();
        break;
      case "D":
        col -= params[0] || 1;
        ensureBounds();
        break;
      case "J":
        eraseInDisplay(params[0] || 0);
        break;
      case "K":
        eraseInLine(params[0] || 0);
        break;
      case "m":
        applySgr(params);
        break;
      default:
        break;
    }
    return true;
  };

  const processText = (text) => {
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\u001b") {
        const next = text[i + 1];
        if (next === "[") {
          let j = i + 2;
          while (j < text.length && !/[@-~]/.test(text[j])) j += 1;
          if (j < text.length) {
            handleEscape(text.slice(i, j + 1));
            i = j + 1;
            continue;
          }
          i = text.length;
          continue;
        }
        if (next === "]") {
          let j = i + 2;
          while (j < text.length) {
            if (text[j] === "\u0007") {
              i = j + 1;
              break;
            }
            if (text[j] === "\u001b" && text[j + 1] === "\\") {
              i = j + 2;
              break;
            }
            j += 1;
          }
          if (j >= text.length) i = text.length;
          continue;
        }
        if (next === "P" || next === "X" || next === "^" || next === "_") {
          let j = i + 2;
          while (j < text.length) {
            if (text[j] === "\u001b" && text[j + 1] === "\\") {
              i = j + 2;
              break;
            }
            j += 1;
          }
          if (j >= text.length) i = text.length;
          continue;
        }
        i += 2;
        continue;
      }
      writeChar(ch);
      i += 1;
    }
  };

  for (const event of eventsUntilTime) {
    processText(event.data);
  }

  const renderRow = (line) => {
    let output = "";
    let runText = "";
    let runKey = null;
    let runCss = "";

    for (const cell of line) {
      const style = cell?.style || {};
      const key = cellStyleKey(style);
      if (runKey === null) {
        runKey = key;
        runCss = cellStyleToCss(style);
      }
      if (key !== runKey) {
        const text = escapeHtml(runText);
        output += runCss ? `<span style="${runCss}">${text}</span>` : text;
        runText = "";
        runKey = key;
        runCss = cellStyleToCss(style);
      }
      runText += cell?.ch ?? " ";
    }

    const tail = escapeHtml(runText);
    output += runCss ? `<span style="${runCss}">${tail}</span>` : tail;
    return output;
  };

  return screen.map((line) => renderRow(line)).join("\n");
}
