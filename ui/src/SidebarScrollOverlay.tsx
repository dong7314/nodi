import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export function SidebarScrollOverlay({
  targetRef,
  compact = false,
  edgeFades = false,
}: {
  targetRef: { current: HTMLElement | null };
  compact?: boolean;
  edgeFades?: boolean;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({
    canScroll: false,
    height: 0,
    top: 0,
    atStart: true,
    atEnd: true,
  });
  const [isScrolling, setIsScrolling] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const visibilityTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{ startY: number; startScrollTop: number } | null>(null);

  useEffect(() => {
    const target = targetRef.current;
    const rail = railRef.current;
    if (!target || !rail) return;

    let frame = 0;
    const reveal = () => {
      setIsScrolling(true);
      if (visibilityTimerRef.current) window.clearTimeout(visibilityTimerRef.current);
      visibilityTimerRef.current = window.setTimeout(() => setIsScrolling(false), 700);
    };
    const refresh = () => {
      const maxScroll = target.scrollHeight - target.clientHeight;
      const canScroll = maxScroll > 1;
      const railHeight = rail.clientHeight;
      const height = canScroll
        ? Math.min(railHeight, Math.max(32, railHeight * target.clientHeight / target.scrollHeight))
        : 0;
      const top = canScroll
        ? target.scrollTop / maxScroll * Math.max(railHeight - height, 0)
        : 0;
      const atStart = !canScroll || target.scrollTop <= 1;
      const atEnd = !canScroll || maxScroll - target.scrollTop <= 1;
      setMetrics((current) => (
        current.canScroll === canScroll
        && Math.abs(current.height - height) < .5
        && Math.abs(current.top - top) < .5
        && current.atStart === atStart
        && current.atEnd === atEnd
          ? current
          : { canScroll, height, top, atStart, atEnd }
      ));
    };
    const scheduleRefresh = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(refresh);
    };
    const onScroll = () => {
      scheduleRefresh();
      reveal();
    };
    const resizeObserver = new ResizeObserver(scheduleRefresh);
    const mutationObserver = new MutationObserver(scheduleRefresh);

    resizeObserver.observe(target);
    resizeObserver.observe(rail);
    mutationObserver.observe(target, { childList: true, subtree: true, characterData: true });
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", scheduleRefresh);
    scheduleRefresh();

    return () => {
      window.cancelAnimationFrame(frame);
      if (visibilityTimerRef.current) window.clearTimeout(visibilityTimerRef.current);
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", scheduleRefresh);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [targetRef]);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = targetRef.current;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startY: event.clientY, startScrollTop: target.scrollTop };
    setIsDragging(true);
  };
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = targetRef.current;
    const rail = railRef.current;
    const start = dragRef.current;
    if (!target || !rail || !start) return;
    const maxScroll = target.scrollHeight - target.clientHeight;
    const thumbTravel = rail.clientHeight - metrics.height;
    target.scrollTop = start.startScrollTop
      + (event.clientY - start.startY) * maxScroll / Math.max(thumbTravel, 1);
  };
  const endDrag = () => {
    dragRef.current = null;
    setIsDragging(false);
  };

  return (
    <>
      {edgeFades && (
        <>
          <div
            className={`sidebar-scroll-fade sidebar-scroll-fade-top ${metrics.canScroll && !metrics.atStart ? "is-visible" : ""}`}
            aria-hidden="true"
          />
          <div
            className={`sidebar-scroll-fade sidebar-scroll-fade-bottom ${metrics.canScroll && !metrics.atEnd ? "is-visible" : ""}`}
            aria-hidden="true"
          />
        </>
      )}
      <div
        ref={railRef}
        className={`sidebar-scrollbar ${compact ? "is-compact" : ""} ${metrics.canScroll ? "has-overflow" : ""} ${isScrolling ? "is-scrolling" : ""} ${isDragging ? "is-dragging" : ""}`}
        aria-hidden="true"
      >
        {metrics.canScroll && (
          <div
            className="sidebar-scrollbar-thumb"
            style={{ height: metrics.height, transform: `translateY(${metrics.top}px)` }}
            onPointerDown={beginDrag}
            onPointerMove={drag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
          />
        )}
      </div>
    </>
  );
}
