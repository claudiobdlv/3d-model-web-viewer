import React, { useRef } from "react";

export function ResizableHeaderCell({
  width,
  minWidth,
  maxWidth,
  onResize,
  children
}: {
  width: number;
  minWidth: number;
  maxWidth: number;
  onResize: (width: number) => void;
  children: React.ReactNode;
}) {
  const frame = useRef<number | null>(null);

  const startResize = (event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    const table = handle.closest("table");
    const startTableWidth = table?.getBoundingClientRect().width ?? 0;
    let nextWidth = width;
    handle.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      nextWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + moveEvent.clientX - startX));
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        handle.parentElement?.style.setProperty("width", `${nextWidth}px`);
        table?.style.setProperty("width", `${startTableWidth + nextWidth - startWidth}px`);
        onResize(nextWidth);
      });
    };
    const finish = () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      handle.removeEventListener("lostpointercapture", finish);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      onResize(nextWidth);
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
  };

  return <th className="resizable-header" style={{ width }}>
    {children}
    <span className="column-resize-handle" onPointerDown={startResize} aria-hidden="true" />
  </th>;
}
