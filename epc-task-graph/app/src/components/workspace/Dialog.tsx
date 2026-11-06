import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";
export function Dialog({
  title,
  subtitle,
  onClose,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    // React の autoFocus は showModal 前（非表示中）に走って効かないため、開いた後に当てる。
    el?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={"workspace-dialog " + className}
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dialog-header">
        <div>
          <h2 id="dialog-title">{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="閉じる"
          type="button"
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
