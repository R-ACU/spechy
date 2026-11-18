// Title collection: one foldable row per rarity with count and bar, owned titles as chips
// (click to equip), the rest folded into a single "N still hidden" chip.
import { useState } from "react";
import { ChevronRight, Lock } from "lucide-react";
import { RANK_TITLE, RARITY_NAME, RARITY_ORDER, TITLES_BY_RARITY, TOTAL_TITLES } from "../../../lib/titles";

interface Props { owned: Set<string>; equipped: string | null; onEquip: (title: string) => void }

export default function TitleCollection({ owned, equipped, onEquip }: Props) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const have = [...owned].filter((t) => t !== RANK_TITLE).length;
  const toggle = (id: string) => setClosed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const groups: { id: string; name: string; list: string[]; rank?: boolean }[] = [
    { id: "rank", name: RARITY_NAME.rank, list: [RANK_TITLE], rank: true },
    ...RARITY_ORDER.map((r) => ({ id: r, name: RARITY_NAME[r], list: TITLES_BY_RARITY[r] })),
  ];

  return (
    <section className="pf-card pf-coll" aria-label="Title collection">
      <div className="pf-coll-head">
        <b>Titles</b>
        <span className="pf-muted">{have} of {TOTAL_TITLES} collected</span>
        <div className="pf-coll-bar"><i style={{ width: `${(have / TOTAL_TITLES) * 100}%` }} /></div>
      </div>
      {groups.map((g) => {
        const got = g.list.filter((t) => owned.has(t));
        const left = g.list.length - got.length;
        const open = !closed.has(g.id);
        return (
          <div key={g.id} className={`pf-group pf-r-${g.id}`}>
            <button type="button" className="pf-group-head" aria-expanded={open} onClick={() => toggle(g.id)}>
              <h3>{g.name}</h3>
              <span className="pf-group-n">{got.length} / {g.list.length}</span>
              <span className="pf-group-bar"><i style={{ width: `${(got.length / g.list.length) * 100}%` }} /></span>
              <ChevronRight size={16} className={`pf-chev ${open ? "open" : ""}`} aria-hidden="true" />
            </button>
            {open && (
              <div className="pf-chips">
                {got.map((t) => (
                  <button key={t} type="button" className={`pf-chip ${t === equipped ? "eq" : ""}`} aria-pressed={t === equipped} onClick={() => onEquip(t)}>
                    {t}
                  </button>
                ))}
                {left > 0 && (
                  <span className="pf-chip locked">
                    <Lock size={12} aria-hidden="true" />
                    {g.rank ? "Reach the Champion rank" : `${left} still hidden`}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
