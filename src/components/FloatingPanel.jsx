import React, { useRef } from "react";

export function FloatingPanel({
  id,
  title,
  layout,
  minWidth = 280,
  minHeight = 180,
  boardRect,
  onLayoutChange,
  onFocus,
  controls,
  children,
}) {
  const dragState = useRef(null);

  const startDrag = (event, mode) => {
    event.preventDefault();
    event.stopPropagation();
    onFocus(id);

    dragState.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      initial: { ...layout },
    };

    const onMove = (moveEvent) => {
      if (!dragState.current) return;
      const { startX, startY, initial } = dragState.current;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      let next = { ...initial };

      if (mode === "move") {
        next.x = initial.x + dx;
        next.y = initial.y + dy;
      } else {
        next.w = initial.w + dx;
        next.h = initial.h + dy;
      }

      next.w = Math.max(minWidth, next.w);
      next.h = Math.max(minHeight, next.h);

      const maxX = Math.max(0, boardRect.width - next.w);
      const maxY = Math.max(0, boardRect.height - next.h);
      next.x = Math.min(Math.max(0, next.x), maxX);
      next.y = Math.min(Math.max(0, next.y), maxY);

      onLayoutChange(id, next, mode);
    };

    const onUp = () => {
      dragState.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <section
      className="floating-panel"
      onPointerDown={() => onFocus(id)}
      style={{
        left: `${layout.x}px`,
        top: `${layout.y}px`,
        width: `${layout.w}px`,
        height: `${layout.h}px`,
        zIndex: layout.z,
      }}
    >
      <header className="floating-header" onPointerDown={(event) => startDrag(event, "move")}>
        <h2>{title}</h2>
        <div className="floating-controls">{controls}</div>
      </header>
      <div className="floating-content">{children}</div>
      <button
        className="resize-handle"
        onPointerDown={(event) => startDrag(event, "resize")}
        aria-label={`Resize ${title}`}
        title="Resize"
      />
    </section>
  );
}
