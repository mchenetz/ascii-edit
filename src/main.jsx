import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const rootEl = document.getElementById("root");

function showFatal(message) {
  if (!rootEl) return;
  rootEl.innerHTML = `
    <div style="padding:16px;font-family:ui-monospace,Menlo,monospace;color:#7a1a1a;background:#fff5f5;border:1px solid #f0bebe;border-radius:8px;margin:12px;">
      <strong>App failed to start</strong><br/>
      <div style="margin-top:8px;white-space:pre-wrap;">${String(message || "Unknown error")}</div>
    </div>
  `;
}

window.addEventListener("error", (event) => {
  if (event?.error) showFatal(event.error.stack || event.error.message);
});

window.addEventListener("unhandledrejection", (event) => {
  showFatal(event?.reason?.stack || event?.reason?.message || String(event?.reason));
});

try {
  createRoot(rootEl).render(<App />);
} catch (error) {
  showFatal(error?.stack || error?.message || error);
}
