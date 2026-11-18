// Profile tab of Games: profile card, custom picture unlock, leaderboard join, display name,
// title picker and the title collection. Economy state comes from lib/economy.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Check, Lock, Trash2, Upload } from "lucide-react";
import { Listbox, Toggle } from "../../../components/ui";
import { useStore } from "../../../lib/store";
import { buyItem, equipItem, fmtCoins, loadEconomy, rankLabel, useEconomy } from "../../../lib/economy";
import { RANK_TITLE, RARITY_NAME, titleRarity, TOTAL_TITLES } from "../../../lib/titles";
import { Coin } from "../economy/Coin";
import { GAMES, readAllBests } from "../catalog";
import CropDialog from "./CropDialog";
import TitleCollection from "./TitleCollection";
import { isJoined, joinedName, leaderboard, serverConfigured, loadAvatar, RankBadge, removeAvatar, storeAvatar, weekRank } from "./bridge";
import "./profile.css";

const PIC_ID = "profile-picture";
const PIC_PRICE = 10000;
const NAME_KEY = "spechy.profile.name";
const SINCE_KEY = "spechy.profile.since";

function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
}

function memberSince(): string {
  let iso = readLocal(SINCE_KEY);
  if (!iso) { iso = new Date().toISOString(); writeLocal(SINCE_KEY, iso); }
  return new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function Avatar({ letter, url, size = 104 }: { letter: string; url: string | null; size?: number }) {
  return (
    <span className="pf-avatar" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {url ? <img src={url} alt="" /> : letter}
    </span>
  );
}

export default function Profile() {
  const { settings } = useStore();
  const { state } = useEconomy();
  const [avatar, setAvatar] = useState<string | null>(null);
  const [localName, setName] = useState(() => readLocal(NAME_KEY) ?? (settings.userName || "Player"));
  const [file, setFile] = useState<File | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [lbReady, setLbReady] = useState(false);
  const [lbBusy, setLbBusy] = useState(false);
  const [status, setStatus] = useState<unknown>(null);
  const input = useRef<HTMLInputElement>(null);
  const since = useRef(memberSince()).current;

  useEffect(() => { if (!state) void loadEconomy().catch(() => {}); }, [state]);
  useEffect(() => { void loadAvatar().then(setAvatar).catch(() => {}); }, []);
  useEffect(() => {
    void leaderboard().then(async (lb) => {
      setLbReady(!!lb?.join);
      if (lb?.getStatus) setStatus(await lb.getStatus().catch(() => null));
    });
  }, []);
  useEffect(() => {
    if (!confirmRemove) return;
    const t = window.setTimeout(() => setConfirmRemove(false), 5000);
    return () => window.clearTimeout(t);
  }, [confirmRemove]);
  useEffect(() => {
    if (!confirm) return;
    const t = window.setTimeout(() => setConfirm(false), 5000);
    return () => window.clearTimeout(t);
  }, [confirm]);

  const rank = state?.rank;
  const balance = state?.balance ?? 0;
  const owned = new Set((state?.inventory ?? []).filter((i) => i.kind === "title").map((i) => i.itemId));
  const unlocked = !!state?.inventory.some((i) => i.itemId === PIC_ID);
  const equipped = state?.equipped.title ?? null;
  const rarity = equipped ? titleRarity(equipped) : null;
  const joined = isJoined(status);
  const name = (joined && joinedName(status)) || localName;
  const bests = readAllBests();
  const tower = GAMES.find((g) => g.id === "tower");
  const towerBest = tower ? Math.max(0, ...tower.bests.map((b) => bests[b.key] ?? 0)) : 0;
  const collected = [...owned].filter((t) => t !== RANK_TITLE).length;
  const rp = rank ? (rank.division == null ? `${rank.rp} RP` : `${rank.rp} / 100 RP`) : "";
  const short = Math.max(0, PIC_PRICE - balance);
  const unlimited = !!state?.unlimited;

  const flash = (msg: string) => {
    setNote(msg);
    window.setTimeout(() => setNote((n) => (n === msg ? "" : n)), 2500);
  };

  const equip = useCallback(async (title: string | null) => {
    setError(null);
    try { await equipItem("title", title); if (title) flash(`${title} equipped`); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }, []);

  const unlock = async () => {
    setError(null);
    if (!confirm) { setConfirm(true); return; }
    setConfirm(false);
    try { await buyItem(PIC_ID); flash("Custom profile picture unlocked"); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  };

  const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { setError("Please choose a PNG, JPG or WEBP image."); return; }
    setError(null);
    setFile(f);
  };

  const savePicture = async (bytes: Uint8Array) => {
    setFile(null);
    try { setAvatar(await storeAvatar(bytes, "image/png")); flash("Profile picture updated"); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  };

  const removePicture = async () => {
    if (!confirmRemove) { setConfirmRemove(true); return; }
    setConfirmRemove(false);
    setError(null);
    try { await removeAvatar(); setAvatar(null); flash("Profile picture removed"); }
    catch (e) { setError(String(e instanceof Error ? e.message : (e as { message?: string })?.message ?? e)); }
  };

  const saveName = async (v: string) => {
    const t = v.trim().slice(0, 20);
    if (t === name) return;
    if (t.length < 3) { setError("Use 3 to 20 characters."); setName(name); return; }
    setError(null);
    if (joined) {
      const lb = await leaderboard();
      try { await lb?.updateMe?.({ name: t }); setStatus(await lb?.getStatus?.().catch(() => null)); }
      catch (e) { setError(lb?.leaderboardErrorMessage?.(e) ?? "That name is not accepted."); return; }
    }
    setName(t);
    writeLocal(NAME_KEY, t);
  };

  const toggleJoin = async (on: boolean) => {
    const lb = await leaderboard();
    if (!lb) return;
    setLbBusy(true);
    setError(null);
    try {
      if (on) await lb.join?.(name); else await lb.leave?.();
      setStatus(await lb.getStatus?.().catch(() => null));
    } catch (e) { setError(lb.leaderboardErrorMessage?.(e) ?? String(e instanceof Error ? e.message : e)); }
    setLbBusy(false);
  };

  const titleOptions = [
    { value: "", label: "No title" },
    ...[...owned].sort().map((t) => {
      const r = titleRarity(t);
      return { value: t, label: t, hint: r ? RARITY_NAME[r] : undefined };
    }),
  ];
  const week = weekRank(status);
  const stats: [string, string][] = [
    ...(joined && week ? [[`#${week}`, "this week"] as [string, string]] : []),
    [`${collected}/${TOTAL_TITLES}`, "titles"],
    [towerBest > 0 ? String(towerBest) : "None", "Pixel Tower best"],
    [String(state?.streak ?? 0), "day streak"],
    [since, "member since"],
  ];

  return (
    <div className="gm-pane pf">
      <section className="pf-card pf-me" aria-label="Your profile">
        <div className={`pf-av pf-tier-${rank?.tier ?? 0}`}>
          <Avatar letter={(name[0] ?? "P").toUpperCase()} url={avatar} />
          <button
            type="button"
            className="pf-cam"
            aria-label={unlocked ? "Change picture" : "Unlock a custom picture"}
            title={unlocked ? "Change picture" : "Unlock for 10,000 coins"}
            onClick={() => (unlocked ? input.current?.click() : document.getElementById("pf-pic-btn")?.focus())}
          >
            {unlocked ? <Camera size={16} aria-hidden="true" /> : <Lock size={16} aria-hidden="true" />}
          </button>
        </div>
        <div className="pf-main">
          <div className="pf-name">
            <span>{name}</span>
            {equipped && <span className={`pf-tag pf-r-${rarity ?? "common"}`}>{equipped}</span>}
          </div>
          <div className="pf-rank">
            {rank && RankBadge && <RankBadge tier={rank.tier} division={rank.division} size={24} />}
            <span><b>{rank ? rankLabel(rank) : "Bronze I"}</b>{rp && ` · ${rp}`}</span>
          </div>
          <div className="pf-stats">
            {stats.map(([v, k]) => <div key={k}><b>{v}</b>{k}</div>)}
          </div>
        </div>
      </section>

      <section className="pf-card pf-pic">
        <div className="pf-grow">
          <div className="pf-t">Custom profile picture</div>
          <div className="pf-muted">
            {!unlocked
              ? "Everyone starts with their initial. Unlock once to upload your own picture."
              : avatar ? "Shown on your profile and on the leaderboard." : "PNG, JPG or WEBP. It is cropped to a circle."}
          </div>
        </div>
        {unlocked ? (
          <>
            <span className="pf-owned"><Check size={14} aria-hidden="true" />Unlocked</span>
            {avatar && confirmRemove && <button type="button" className="btn btn-ghost" onClick={() => setConfirmRemove(false)}>Cancel</button>}
            {avatar && (
              <button type="button" className={`btn ${confirmRemove ? "btn-danger" : "btn-secondary"}`} onClick={() => void removePicture()}>
                <Trash2 size={16} aria-hidden="true" />{confirmRemove ? "Confirm remove" : "Remove picture"}
              </button>
            )}
            <button type="button" className="btn btn-primary" id="pf-pic-btn" onClick={() => input.current?.click()}>
              <Upload size={16} aria-hidden="true" />{avatar ? "Change picture" : "Upload picture"}
            </button>
          </>
        ) : (
          <>
            <span className="pf-price"><Coin size={18} />{fmtCoins(PIC_PRICE)}</span>
            {confirm && <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)}>Cancel</button>}
            <button
              type="button"
              id="pf-pic-btn"
              className={`btn ${confirm ? "pf-confirm" : "btn-primary"}`}
              disabled={!unlimited && short > 0}
              onClick={unlock}
            >
              {!unlimited && short > 0 ? `Need ${fmtCoins(short)} more` : confirm ? `Confirm, pay ${fmtCoins(PIC_PRICE)}` : "Unlock"}
            </button>
          </>
        )}
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onPicked} />
      </section>

      <section className="pf-card pf-rows">
        <div className="pf-row">
          <div>
            <div className="pf-t">Join the leaderboard</div>
            <div className="pf-muted">
              {lbReady && serverConfigured(status)
                ? "Shares your name, weekly points and game bests. Never your dictated text. Off by default."
                : "The leaderboard is not available yet."}
            </div>
          </div>
          <Toggle on={joined} onChange={toggleJoin} disabled={!lbReady || !serverConfigured(status) || lbBusy} label="Join the leaderboard" />
        </div>
        <div className="pf-row">
          <div>
            <div className="pf-t">Display name</div>
            <div className="pf-muted">What others see next to your score.</div>
          </div>
          <input
            className="input pf-name-input"
            aria-label="Display name"
            maxLength={20}
            defaultValue={name}
            key={name}
            onBlur={(e) => saveName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          />
        </div>
        <div className="pf-row">
          <div>
            <div className="pf-t">Title</div>
            <div className="pf-muted">Pull titles from boxes. Champion only comes with the rank.</div>
          </div>
          <Listbox className="pf-title-pick" value={equipped ?? ""} options={titleOptions} onChange={(v) => void equip(v || null)} />
        </div>
      </section>

      <TitleCollection owned={owned} equipped={equipped} onEquip={(t) => void equip(t)} />

      <div className="pf-live" role="status" aria-live="polite">{note}</div>
      {error && <p className="pf-error" role="alert">{error}</p>}
      {file && <CropDialog file={file} onCancel={() => setFile(null)} onDone={(b) => void savePicture(b)} />}
    </div>
  );
}
