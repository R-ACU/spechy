import { useEffect } from "react";
import type { Toast } from "../lib/ipc";

export interface ToastItem extends Toast { id: number }

function Item({ item, onDone }: { item: ToastItem; onDone: (id: number) => void }) {
  useEffect(() => {
    const h = window.setTimeout(() => onDone(item.id), 3000);
    return () => window.clearTimeout(h);
  }, [item.id, onDone]);
  return <div className={`toast ${item.kind}`} role="status">{item.message}</div>;
}

export default function Toasts({ items, onDone }: { items: ToastItem[]; onDone: (id: number) => void }) {
  if (!items.length) return null;
  return (
    <div className="toast-stack">
      {items.map((t) => <Item key={t.id} item={t} onDone={onDone} />)}
    </div>
  );
}
