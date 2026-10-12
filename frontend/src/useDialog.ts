import { useEffect, useRef } from "react";
/** Keep keyboard focus inside dialogs and restore it when the dialog closes. */
export function useDialog<T extends HTMLElement>(
  close: () => void,
  canClose = true,
) {
  const ref = useRef<T>(null);
  const closeRef = useRef(close);
  const allowed = useRef(canClose);
  closeRef.current = close;
  allowed.current = canClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    if (!root) return;
    const focusable = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
        ),
      ).filter((e) => e.getClientRects().length > 0);
    if (!root.contains(document.activeElement)) focusable()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && allowed.current) {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === "Tab") {
        const all = focusable();
        const first = all[0],
          last = all.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    root.addEventListener("keydown", key);
    return () => {
      root.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return ref;
}
