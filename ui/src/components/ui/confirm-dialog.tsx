import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

type ConfirmDialogProps = {
  ariaLabel: string;
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({
  ariaLabel,
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const [isClosing, setIsClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  const closeWithAnimation = (afterClose: () => void) => {
    if (isClosing) return;
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      afterClose();
    }, 140);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isClosing) return;
      event.preventDefault();
      closeWithAnimation(onCancel);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isClosing, onCancel]);

  return createPortal(
    <div
      className={`record-confirm-layer ${isClosing ? "is-closing" : ""}`}
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeWithAnimation(onCancel);
      }}
    >
      <div
        className="record-confirm database-delete-confirm"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="record-confirm-close"
          aria-label={`${ariaLabel} 닫기`}
          disabled={isClosing}
          onClick={() => closeWithAnimation(onCancel)}
        >
          <X size={16} />
        </button>
        <strong>{title}</strong>
        <p>{description}</p>
        <div>
          <button type="button" disabled={isClosing} onClick={() => closeWithAnimation(onCancel)}>
            취소
          </button>
          <button
            className="confirm-delete"
            type="button"
            disabled={isClosing}
            onClick={() => closeWithAnimation(onConfirm)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
