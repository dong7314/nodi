import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";

const BLOCKNOTE_SCROLL_TARGET_SELECTOR = [
  ".bn-mantine .bn-color-picker-dropdown",
  ".bn-mantine .bn-select",
].join(", ");

type ScrollTarget = {
  id: number;
  element: HTMLElement;
};

type OverlayMetrics = {
  canScroll: boolean;
  railTop: number;
  railLeft: number;
  railHeight: number;
  thumbHeight: number;
  thumbTop: number;
};

const EMPTY_METRICS: OverlayMetrics = {
  canScroll: false,
  railTop: 0,
  railLeft: 0,
  railHeight: 0,
  thumbHeight: 0,
  thumbTop: 0,
};

function metricsAreEqual(current: OverlayMetrics, next: OverlayMetrics) {
  return current.canScroll === next.canScroll
    && Math.abs(current.railTop - next.railTop) < .5
    && Math.abs(current.railLeft - next.railLeft) < .5
    && Math.abs(current.railHeight - next.railHeight) < .5
    && Math.abs(current.thumbHeight - next.thumbHeight) < .5
    && Math.abs(current.thumbTop - next.thumbTop) < .5;
}

function BlockNotePopoverScrollOverlay({ target }: { target: HTMLElement }) {
  const [metrics, setMetrics] = useState<OverlayMetrics>(EMPTY_METRICS);
  const [isHovering, setIsHovering] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const visibilityTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{ startY: number; startScrollTop: number } | null>(null);
  const metricsRef = useRef<OverlayMetrics>(EMPTY_METRICS);
  const thumbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    target.classList.add("nodi-popover-native-scroll");

    const reveal = () => {
      setIsScrolling(true);
      if (visibilityTimerRef.current) window.clearTimeout(visibilityTimerRef.current);
      visibilityTimerRef.current = window.setTimeout(() => setIsScrolling(false), 700);
    };
    const refresh = () => {
      if (!target.isConnected) return;
      const rect = target.getBoundingClientRect();
      const railHeight = Math.max(rect.height - 8, 0);
      const maxScroll = target.scrollHeight - target.clientHeight;
      const canScroll = maxScroll > 1 && rect.width > 0 && railHeight > 0;
      const thumbHeight = canScroll
        ? Math.min(railHeight, Math.max(32, railHeight * target.clientHeight / target.scrollHeight))
        : 0;
      const thumbTop = canScroll
        ? target.scrollTop / maxScroll * Math.max(railHeight - thumbHeight, 0)
        : 0;
      const next = canScroll
        ? {
            canScroll,
            railTop: rect.top + 4,
            railLeft: rect.right - 13,
            railHeight,
            thumbHeight,
            thumbTop,
          }
        : EMPTY_METRICS;
      metricsRef.current = next;
      setMetrics((current) => metricsAreEqual(current, next) ? current : next);
      frame = window.requestAnimationFrame(refresh);
    };
    const handlePointerEnter = () => setIsHovering(true);
    const handlePointerLeave = () => setIsHovering(false);
    const handleFocusIn = () => setIsFocused(true);
    const handleFocusOut = () => {
      window.requestAnimationFrame(() => setIsFocused(target.contains(document.activeElement)));
    };
    const handleScroll = () => reveal();
    const handleWindowPointerDown = (event: PointerEvent) => {
      const thumb = thumbRef.current;
      if (!thumb || !(event.target instanceof Node) || !thumb.contains(event.target)) return;

      // The floating menu regards a body portal as an outside click. Handle the
      // scrollbar at the window capture phase so dragging it never closes the menu.
      event.preventDefault();
      event.stopImmediatePropagation();
      dragRef.current = { startY: event.clientY, startScrollTop: target.scrollTop };
      setIsDragging(true);
    };
    const handleWindowPointerMove = (event: PointerEvent) => {
      const start = dragRef.current;
      if (!start) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      const currentMetrics = metricsRef.current;
      const maxScroll = target.scrollHeight - target.clientHeight;
      const thumbTravel = currentMetrics.railHeight - currentMetrics.thumbHeight;
      target.scrollTop = start.startScrollTop
        + (event.clientY - start.startY) * maxScroll / Math.max(thumbTravel, 1);
    };
    const handleWindowPointerEnd = (event: PointerEvent) => {
      if (!dragRef.current) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      dragRef.current = null;
      setIsDragging(false);
    };

    target.addEventListener("pointerenter", handlePointerEnter);
    target.addEventListener("pointerleave", handlePointerLeave);
    target.addEventListener("focusin", handleFocusIn);
    target.addEventListener("focusout", handleFocusOut);
    target.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("pointerdown", handleWindowPointerDown, true);
    window.addEventListener("pointermove", handleWindowPointerMove, true);
    window.addEventListener("pointerup", handleWindowPointerEnd, true);
    window.addEventListener("pointercancel", handleWindowPointerEnd, true);
    setIsHovering(target.matches(":hover"));
    setIsFocused(target.contains(document.activeElement));
    frame = window.requestAnimationFrame(refresh);

    return () => {
      window.cancelAnimationFrame(frame);
      if (visibilityTimerRef.current) window.clearTimeout(visibilityTimerRef.current);
      target.classList.remove("nodi-popover-native-scroll");
      target.removeEventListener("pointerenter", handlePointerEnter);
      target.removeEventListener("pointerleave", handlePointerLeave);
      target.removeEventListener("focusin", handleFocusIn);
      target.removeEventListener("focusout", handleFocusOut);
      target.removeEventListener("scroll", handleScroll);
      window.removeEventListener("pointerdown", handleWindowPointerDown, true);
      window.removeEventListener("pointermove", handleWindowPointerMove, true);
      window.removeEventListener("pointerup", handleWindowPointerEnd, true);
      window.removeEventListener("pointercancel", handleWindowPointerEnd, true);
    };
  }, [target]);

  if (!metrics.canScroll) return null;

  return createPortal(
    <div
      className={`sidebar-scrollbar nodi-popover-scrollbar ${isHovering || isFocused ? "is-visible" : ""} ${isScrolling ? "is-scrolling" : ""} ${isDragging ? "is-dragging" : ""}`}
      aria-hidden="true"
      style={{
        top: metrics.railTop,
        left: metrics.railLeft,
        height: metrics.railHeight,
      }}
    >
      <div
        ref={thumbRef}
        className="sidebar-scrollbar-thumb"
        style={{ height: metrics.thumbHeight, transform: `translateY(${metrics.thumbTop}px)` }}
      />
    </div>,
    document.body,
  );
}

export function BlockNotePopoverScrollOverlays() {
  const [targets, setTargets] = useState<ScrollTarget[]>([]);
  const targetIdsRef = useRef(new WeakMap<HTMLElement, number>());
  const nextTargetIdRef = useRef(1);

  useEffect(() => {
    let frame = 0;
    const scan = () => {
      frame = 0;
      const nextTargets = [...document.querySelectorAll<HTMLElement>(BLOCKNOTE_SCROLL_TARGET_SELECTOR)]
        .filter((element) => element.isConnected)
        .map((element) => {
          let id = targetIdsRef.current.get(element);
          if (!id) {
            id = nextTargetIdRef.current;
            nextTargetIdRef.current += 1;
            targetIdsRef.current.set(element, id);
          }
          return { id, element };
        });
      setTargets((current) => (
        current.length === nextTargets.length
        && current.every((target, index) => target.element === nextTargets[index].element)
          ? current
          : nextTargets
      ));
    };
    const scheduleScan = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(scan);
    };
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleScan();

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return targets.map((target) => (
    <BlockNotePopoverScrollOverlay key={target.id} target={target.element} />
  ));
}
