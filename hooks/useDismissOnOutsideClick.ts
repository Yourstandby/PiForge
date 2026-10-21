import { useEffect, useRef, type RefObject } from "react";

export type DismissReason = "outside" | "escape";

type RefLike = RefObject<HTMLElement | null>;

/**
 * Close on outside pointerdown / Escape.
 *
 * Accepts several refs so a dropdown rendered through a portal (whose DOM is
 * outside the trigger's subtree) can still count as "inside".
 */
export function useDismissOnOutsideClick(
  ref: RefLike | RefLike[],
  open: boolean,
  onClose: (reason: DismissReason) => void,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const refs = Array.isArray(ref) ? ref : [ref];
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const inside = refs.some((item) => item.current?.contains(target));
      if (!inside) onCloseRef.current("outside");
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current("escape");
    };

    document.addEventListener("pointerdown", handlePointerDown);
    // Capture so a nested picker/menu consumes Escape before a parent dialog
    // that still listens on bubble (backdrop click / input onKeyDown).
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, ref]);
}
