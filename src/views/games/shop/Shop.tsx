// Shop tab of Games: premium themes (big cards with a live preview), the three title boxes
// (parcels, odds, casino opening), pill colours and game skins, plus a side panel with the
// week's earnings, the streak and how coins are earned. Everything goes through
// src/lib/economy.ts; prices and odds live in src-tauri/src/economy.rs (mirrored below for display).
// Buying is two clicks: Buy turns into Confirm, a click anywhere else cancels.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Eye, EyeOff, FileText, Gamepad2, KeyRound, Lock, Mic, Package, Palette, Sparkles, Trophy, type LucideIcon } from "lucide-react";
import type { BoxId, BoxState, EconomyState, EquipSlot } from "../../../lib/ipc";
import { buyItem, equipItem, fmtCoins, loadEconomy, useEconomy } from "../../../lib/economy";
import { useStore } from "../../../lib/store";
import { isThemeId } from "../../../themes/registry";
import { Coin } from "../economy/Coin";
import { configureSfx } from "../economy/sfx";
import BoxOpening from "./BoxOpening";
import { openSfx } from "./openSfx";
import { parcelHtml } from "./parcels";
import { paintSkinPreview } from "./gameSkins";
import { paintPillPreview } from "./pillSkins";
import { loadPremium, PREMIUM_FALLBACK, type PremiumModule, type PremiumThemeInfo } from "./premium";
import { BOX_INFO, RARITY_NAME } from "./titles";
import "./shop.css";

type Cat = "all" | "theme" | "box" | "pill" | "game";
const CATS: { id: Cat; label: string; icon?: LucideIcon }[] = [
  { id: "all", label: "All" },
  { id: "theme", label: "Themes", icon: Palette },
  { id: "box", label: "Title boxes", icon: Package },
  { id: "pill", label: "Pill", icon: Mic },
  { id: "game", label: "Game skins", icon: Gamepad2 },
];

/** Prices mirror SHOP in economy.rs (the backend charges its own price). */
const THEME_PRICE: Record<string, number> = { bloom: 4000, genesis: 5000, horizon: 5500 };

interface Item { id: string; cat: "pill" | "game"; slot: EquipSlot; name: string; line: string; price: number; preview: ReactNode }

// Previews are small game and pill illustrations: fixed colours are art here.
/** The real recording pill (same rasterizer geometry as the native one), dots gently moving. */
function PillCanvas({ skin }: { skin: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (still) { paintPillPreview(cv, skin); return; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      paintPillPreview(cv, skin, { time: 0.32 + (now - t0) / 1000 * 0.45, level: 0.75 });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [skin]);
  return <canvas ref={ref} className="sp-skin-cv" width={424} height={256} aria-hidden="true" />;
}
const pillPreview = (skin: string) => <PillCanvas skin={skin} />;
/** Game skins draw their real look onto a canvas (painters live in gameSkins.ts). */
function SkinCanvas({ skin }: { skin: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (ref.current) paintSkinPreview(ref.current, skin); }, [skin]);
  return <canvas ref={ref} className="sp-skin-cv" width={320} height={160} aria-hidden="true" />;
}
const skinPreview = (skin: string) => <SkinCanvas skin={skin} />;

const ITEMS: Item[] = [
  { id: "pill-amber", cat: "pill", slot: "pill", name: "Amber Pill", line: "Warm level dots while you speak.", price: 350, preview: pillPreview("pill-amber") },
  { id: "pill-mint", cat: "pill", slot: "pill", name: "Mint Pill", line: "Cool green dots on the dark pill.", price: 350, preview: pillPreview("pill-mint") },
  { id: "pill-coral", cat: "pill", slot: "pill", name: "Coral Pill", line: "Soft red dots, easy to spot.", price: 350, preview: pillPreview("pill-coral") },
  { id: "comet-ice", cat: "game", slot: "comet-skin", name: "Ice Comets", line: "Comet Keeper trail and planets.", price: 180, preview: skinPreview("comet-ice") },
  { id: "tower-sunset", cat: "game", slot: "tower-skin", name: "Sunset Blocks", line: "Pixel Tower block colours.", price: 150, preview: skinPreview("tower-sunset") },
  { id: "snake-neon", cat: "game", slot: "snake-skin", name: "Neon Snake", line: "Voice Snake skin.", price: 120, preview: skinPreview("snake-neon") },
];

const owns = (s: EconomyState | null, id: string) => !!s?.inventory.some((i) => i.itemId === id);
const canPay = (s: EconomyState | null, price: number) => !!s && (s.unlimited || s.balance >= price);
const errText = (e: unknown) => String(e).replace(/^Error:\s*/, "");

/** Price plus the Buy / Confirm / Need more button of one item. */
function BuyFoot({ id, price, state, pending, onBuy }: { id: string; price: number; state: EconomyState | null; pending: string | null; onBuy: (id: string) => void }) {
  const price_ = <span className="sp-price"><Coin size={16} />{fmtCoins(price)}</span>;
  if (pending === id) {
    return <>{price_}<button type="button" className="btn shop-btn shop-btn-confirm" data-buy={id} onClick={() => onBuy(id)}>Confirm</button></>;
  }
  if (!canPay(state, price)) {
    return <>{price_}<button type="button" className="btn shop-btn" disabled title="Not enough coins yet">Need {fmtCoins(price - (state?.balance ?? 0))}</button></>;
  }
  return <>{price_}<button type="button" className="btn shop-btn shop-btn-ink" data-buy={id} onClick={() => onBuy(id)}>Buy</button></>;
}

function Owned() {
  return <span className="sp-owned"><Check size={15} aria-hidden="true" />Owned</span>;
}

/* ---------- themes */
function ThemeCard({ th, mod, first, state, pending, previewing, onBuy, onPreview, onUse }: {
  th: PremiumThemeInfo; mod: PremiumModule | null; first: boolean; state: EconomyState | null; pending: string | null;
  previewing: string | null; onBuy: (id: string) => void; onPreview: (id: string | null) => void; onUse: (th: PremiumThemeInfo) => void;
}) {
  const owned = owns(state, th.itemId);
  const inUse = state?.equipped.theme === th.itemId;
  const usable = !!mod && isThemeId(th.id);
  const Preview = mod?.ThemeCardPreview;
  const on = previewing === th.id;
  return (
    <div className={`sp-card sp-feat ${first ? "sp-feat-wide" : ""}`}>
      <div className="sp-prev sp-feat-prev">
        {Preview ? <Preview id={th.id} /> : (
          <div className="sp-feat-ph" aria-hidden="true">
            <Palette size={26} strokeWidth={1.6} />
            <span>Live preview coming soon</span>
          </div>
        )}
      </div>
      <div>
        <div className="sp-name">{th.name}</div>
        <div className="sp-line">{th.line}</div>
      </div>
      <div className="sp-foot">
        <span className="sp-foot-l">
          {owned ? (
            <>
              <Owned />
              {inUse ? <span className="sp-inuse">In use</span>
                : usable ? <button type="button" className="btn shop-btn shop-btn-ghost" onClick={() => onUse(th)}>Use</button>
                : <span className="sp-soon">Coming soon</span>}
            </>
          ) : <BuyFoot id={th.itemId} price={THEME_PRICE[th.itemId] ?? 0} state={state} pending={pending} onBuy={onBuy} />}
        </span>
        {mod && (
          <button type="button" className="btn shop-btn shop-btn-ghost" aria-pressed={on} onClick={() => onPreview(on ? null : th.id)}>
            {on ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
            {on ? "Stop preview" : "Preview"}
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- title boxes */
function Parcel({ id, size }: { id: BoxId; size: number }) {
  const html = useMemo(() => parcelHtml(id, size), [id, size]);
  return <span className="sp-parcel" dangerouslySetInnerHTML={{ __html: html }} />;
}

function BoxCard({ box, state, pending, onOpen }: { box: BoxState; state: EconomyState | null; pending: string | null; onOpen: (id: BoxId) => void }) {
  const info = BOX_INFO.find((b) => b.id === box.id)!;
  const key = `box:${box.id}`;
  const left = box.pity ? Math.max(1, box.pity - box.sinceLegendary) : null;
  let foot: ReactNode;
  if (box.keys > 0) {
    foot = (
      <>
        <span className="sp-price sp-free"><KeyRound size={15} aria-hidden="true" />{box.keys} free</span>
        <button type="button" className="btn shop-btn shop-btn-ink" onClick={() => onOpen(box.id)}>Open free</button>
      </>
    );
  } else if (pending === key) {
    foot = <><span className="sp-price"><Coin size={16} />{fmtCoins(box.price)}</span><button type="button" className="btn shop-btn shop-btn-confirm" data-buy={key} onClick={() => onOpen(box.id)}>Confirm</button></>;
  } else if (!canPay(state, box.price)) {
    foot = <><span className="sp-price"><Coin size={16} />{fmtCoins(box.price)}</span><button type="button" className="btn shop-btn" disabled title="Not enough coins yet">Need {fmtCoins(box.price - (state?.balance ?? 0))}</button></>;
  } else {
    foot = <><span className="sp-price"><Coin size={16} />{fmtCoins(box.price)}</span><button type="button" className="btn shop-btn shop-btn-ink" data-buy={key} onClick={() => onOpen(box.id)}>Open</button></>;
  }
  return (
    <div className={`sp-card sp-box sp-box-${box.id}`}>
      <div className="sp-box-prev">
        <Parcel id={box.id} size={112} />
        {box.keys > 0 && <span className="sp-keys">{box.keys} free</span>}
      </div>
      <div>
        <div className="sp-box-tier">{info.tier}</div>
        <div className="sp-name">{info.name}</div>
        <div className="sp-odds" aria-hidden="true">
          {info.odds.map(([r, p]) => <i key={r} style={{ width: `${p}%`, background: `var(--rarity-${r})` }} />)}
        </div>
        <div className="sp-odds-l">
          {info.odds.map(([r, p]) => <span key={r} style={{ "--rc": `var(--rarity-${r})` } as CSSProperties}>{RARITY_NAME[r]} {p}%</span>)}
        </div>
        {left != null && <div className="sp-pity">Legendary guaranteed within {left} {left === 1 ? "open" : "opens"}</div>}
      </div>
      <div className="sp-foot">{foot}</div>
    </div>
  );
}

/* ---------- pill colours and game skins */
function ItemCard({ it, state, pending, onBuy, onEquip }: { it: Item; state: EconomyState | null; pending: string | null; onBuy: (id: string) => void; onEquip: (it: Item, on: boolean) => void }) {
  const owned = owns(state, it.id);
  const inUse = state?.equipped[it.slot] === it.id;
  return (
    <div className="sp-card">
      <div className={`sp-prev sp-prev-${it.cat}`}>{it.preview}</div>
      <div>
        <div className="sp-name">{it.name}</div>
        <div className="sp-line">{it.line}</div>
      </div>
      <div className="sp-foot">
        {owned ? (
          <>
            <span className="sp-foot-l">
              <Owned />
              {inUse && <span className="sp-inuse">In use</span>}
            </span>
            <button type="button" className="btn shop-btn shop-btn-ghost" onClick={() => onEquip(it, !inUse)}>{inUse ? "Unequip" : "Use"}</button>
          </>
        ) : <BuyFoot id={it.id} price={it.price} state={state} pending={pending} onBuy={onBuy} />}
      </div>
    </div>
  );
}

/* ---------- side panel */
function Earn({ icon: Icon, title, sub, value }: { icon: LucideIcon; title: string; sub: ReactNode; value: string }) {
  return (
    <div className="sp-earn">
      <span className="sp-earn-ic"><Icon size={16} aria-hidden="true" /></span>
      <div className="sp-earn-t">{title}<div className="sp-muted">{sub}</div></div>
      <span className="sp-earn-v">{value}</span>
    </div>
  );
}

function Side({ state }: { state: EconomyState | null }) {
  const streak = state?.streak ?? 0;
  const rates = state?.earnRates;
  const nextDay = rates?.nextDayCoins ?? 0;
  const words = state?.wordsTowardNext ?? 0;
  const today = state?.today;
  return (
    <aside className="sp-side">
      <h4>This week</h4>
      <div className="sp-week"><b><Coin size={18} />+{fmtCoins(state?.weekEarned ?? 0)}</b><span className="sp-muted">earned since Monday 00:00 UTC</span></div>
      <h4>Daily streak</h4>
      <div className="sp-streak">
        <b>{streak}</b> {streak === 1 ? "day" : "days"}
        <span className="sp-muted">Your next dictation day pays +{nextDay}.</span>
      </div>
      <h4>How you earn</h4>
      <Earn icon={Mic} title="Dictate on a new day" sub={`Streak bonus grows to ${rates?.dayCoinsMax ?? ""}`} value={`+${rates?.dayCoins ?? ""}`} />
      <Earn icon={FileText} title="Every 1,000 words" sub={<div className="sp-bar"><i style={{ width: `${Math.min(100, words / 10)}%` }} /></div>} value={`+${rates?.wordsCoins ?? ""}`} />
      <Earn icon={Gamepad2} title="Game rounds" sub={`Today ${today?.gameCoins ?? 0} of ${today?.gameCoinCap ?? ""}`} value={`up to ${rates?.roundCoinMax ?? ""}`} />
      <Earn icon={Sparkles} title="New best in a game" sub={`Today ${today?.bestBonuses ?? 0} of ${today?.bestBonusCap ?? 3}`} value={`+${rates?.bestBonus ?? ""}`} />
      <Earn icon={Trophy} title="Rank up" sub="New tiers pay more" value={`+${rates?.divisionCoins ?? ""} and up`} />
    </aside>
  );
}

export default function Shop() {
  const { state } = useEconomy();
  const { toast, update, settings } = useStore();
  const [cat, setCat] = useState<Cat>("all");
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<{ id: BoxId; n: number } | null>(null);
  const [mod, setMod] = useState<PremiumModule | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const modRef = useRef<PremiumModule | null>(null);

  useEffect(() => { if (!state) void loadEconomy().catch(() => {}); }, [state]);
  useEffect(() => {
    let alive = true;
    void loadPremium().then((m) => { if (alive) { modRef.current = m; setMod(m); } });
    return () => { alive = false; modRef.current?.stopThemePreview(); };
  }, []);

  // A click anywhere but the confirm button cancels a pending purchase.
  useEffect(() => {
    if (!pending) return;
    const off = (e: PointerEvent) => { if (!(e.target as Element).closest(`[data-buy="${pending}"]`)) setPending(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setPending(null); };
    document.addEventListener("pointerdown", off, true);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", off, true); document.removeEventListener("keydown", esc); };
  }, [pending]);

  // Newest showpiece first and wide, as in the mockup (Event Horizon, Genesis, Bloom).
  const themes = useMemo(() => {
    const list = mod?.PREMIUM_THEMES.length ? mod.PREMIUM_THEMES : PREMIUM_FALLBACK;
    const at = (id: string) => { const i = PREMIUM_FALLBACK.findIndex((t) => t.id === id); return i < 0 ? 99 : i; };
    return [...list].sort((x, y) => at(x.id) - at(y.id));
  }, [mod]);
  const nameOf = useCallback((id: string) => themes.find((t) => t.itemId === id)?.name ?? ITEMS.find((i) => i.id === id)?.name ?? id, [themes]);

  const buy = async (id: string) => {
    if (pending !== id) { setPending(id); return; }
    if (busy) return;
    setBusy(true);
    try {
      await buyItem(id);
      configureSfx(settings.sounds !== false, 0.8);
      openSfx.bought();
      toast({ kind: "success", message: `${nameOf(id)} unlocked` });
    } catch (e) {
      toast({ kind: "error", message: errText(e) });
    } finally {
      setPending(null);
      setBusy(false);
    }
  };

  const open = (id: BoxId) => {
    const box = state?.boxes.find((b) => b.id === id);
    if (!box) return;
    if (box.keys === 0 && pending !== `box:${id}`) { setPending(`box:${id}`); return; }
    setPending(null);
    setOpening({ id, n: (opening?.n ?? 0) + 1 });
  };

  const preview = (id: string | null) => {
    if (!mod) return;
    if (id) mod.startThemePreview(id); else mod.stopThemePreview();
    setPreviewing(id);
  };

  const use = async (th: PremiumThemeInfo) => {
    try {
      await equipItem("theme", th.itemId);
      if (previewing) preview(null);
      await update({ theme: th.id });
      toast({ kind: "success", message: `${th.name} is on` });
    } catch (e) {
      toast({ kind: "error", message: errText(e) });
    }
  };

  const equip = async (it: Item, on: boolean) => {
    try {
      await equipItem(it.slot, on ? it.id : null);
      toast({ kind: "success", message: on ? `${it.name} is on` : `${it.name} is off, back to the default` });
    } catch (e) {
      toast({ kind: "error", message: errText(e) });
    }
  };

  const show = (c: Exclude<Cat, "all">) => cat === "all" || cat === c;
  const items = ITEMS.filter((it) => show(it.cat));
  const boxes = state?.boxes ?? [];

  return (
    <div className="gm-pane shop-root">
     <div className="shop">
      <div className="sp-main">
        <p className="sp-sub">Spend coins on looks. Nothing here changes how Spechy dictates.</p>
        <div className="sp-cats" role="tablist" aria-label="Shop categories">
          {CATS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={cat === id} className={cat === id ? "on" : ""} onClick={() => { setCat(id); setPending(null); }}>
              {Icon && <Icon size={15} aria-hidden="true" />}{label}
            </button>
          ))}
        </div>

        {show("theme") && (
          <div className="sp-feat-grid">
            {themes.map((th, i) => (
              <ThemeCard key={th.id} th={th} mod={mod} first={i === 0} state={state} pending={pending} previewing={previewing} onBuy={(id) => void buy(id)} onPreview={preview} onUse={(t) => void use(t)} />
            ))}
          </div>
        )}
        {show("box") && (
          <>
            {cat === "all" && <h3 className="sp-h">Title boxes</h3>}
            <div className="sp-box-grid">
              {boxes.map((b) => <BoxCard key={b.id} box={b} state={state} pending={pending} onOpen={open} />)}
            </div>
            <p className="sp-note"><Lock size={13} aria-hidden="true" />Titles only come from boxes. Duplicates pay coins back. Champion comes only with the Champion rank.</p>
          </>
        )}
        {items.length > 0 && (
          <>
            {cat === "all" && <h3 className="sp-h">Pill and game skins</h3>}
            <div className="sp-grid">
              {items.map((it) => <ItemCard key={it.id} it={it} state={state} pending={pending} onBuy={(id) => void buy(id)} onEquip={(i, on) => void equip(i, on)} />)}
            </div>
          </>
        )}
      </div>

      <Side state={state} />
     </div>

      {previewing && mod && (
        <div className="sp-preview-bar" role="status">
          <Eye size={16} aria-hidden="true" />
          <span>Previewing <b>{nameOf(themes.find((t) => t.id === previewing)?.itemId ?? previewing)}</b></span>
          <button type="button" className="btn shop-btn shop-btn-ghost" onClick={() => preview(null)}>Stop preview</button>
        </div>
      )}

      {opening && createPortal(
        <BoxOpening
          key={opening.n}
          boxId={opening.id}
          onClose={() => setOpening(null)}
          onAgain={() => setOpening((o) => (o ? { id: o.id, n: o.n + 1 } : o))}
        />,
        document.body,
      )}
    </div>
  );
}
