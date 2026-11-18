// Leaderboard tab of Games. The rank card, the Monday payout and the rank rewards ladder are
// local and always visible. The list itself is strictly opt-in: until the player joins, Spechy
// talks to no server and loads nothing (no lists, no pictures). The server client is
// src/lib/leaderboard.ts: getStatus() is local, every other call refuses before joining.
import { useCallback, useEffect, useRef, useState } from "react";
import { Flag, LogOut, MoreHorizontal, ShieldCheck } from "lucide-react";
import { useStore } from "../../../lib/store";
import { fmtCoins, loadEconomy, useEconomy } from "../../../lib/economy";
import { Menu } from "../../../components/ui";
import GameTitle from "../GameTitle";
import { RankBadge } from "../rank/RankBadge";
import { PayoutCard, RankCard, RankLadder, TitleTag } from "../rank/RankPanels";
import { setRankSound } from "../rank/rankHost";
import * as client from "../../../lib/leaderboard";
import type { Board, LeaderboardCategory, LeaderboardStatus, Row } from "../../../lib/leaderboard";
import JoinView from "./JoinView";
import "./leaderboard.css";

type BoardCat = LeaderboardCategory;
type BoardRow = Row;
type LbStatus = LeaderboardStatus;
type LeaderboardApi = typeof client;
const errText = (e: unknown) => client.leaderboardErrorMessage(e);

// ---------------------------------------------------------------- view

const CATS: { id: BoardCat; label: string; game?: "tower" | "snake" | "comet" }[] = [
  { id: "overall", label: "Overall" },
  { id: "words", label: "Words" },
  { id: "tower", label: "Pixel Tower", game: "tower" },
  { id: "snake", label: "Voice Snake", game: "snake" },
  { id: "comet", label: "Comet Keeper", game: "comet" },
];
const CAPTION: Record<BoardCat, string> = {
  overall: "points this week", words: "words this week", tower: "floors, best", snake: "length, best", comet: "score, best",
};
// Dev only: preview the release state without a configured server ("Coming soon").
const devComingSoon = () => {
  try { return localStorage.getItem("spechy.dev.leaderboard.comingSoon") === "1"; } catch { return false; }
};

export default function Leaderboard() {
  const { settings, toast } = useStore();
  const { state } = useEconomy();
  const api: LeaderboardApi = client;
  const [status, setStatus] = useState<LbStatus | null>(null);
  const [syncs, setSyncs] = useState(0);

  useEffect(() => { setRankSound(settings.sounds !== false); }, [settings.sounds]);
  useEffect(() => { void loadEconomy().catch(() => {}); }, []);

  // Only the local status: no network until the player has joined.
  const refreshStatus = useCallback(async () => {
    try { setStatus(await client.getStatus()); } catch { setStatus({ joined: false, serverConfigured: false }); }
  }, []);
  useEffect(() => { void refreshStatus(); }, [refreshStatus]);
  // Joins, leaves (also from Profile), moderation and finished syncs.
  useEffect(() => client.onChanged((s) => { setStatus(s); setSyncs((n) => n + 1); }), []);

  const joined = !!status?.joined;
  const [cat, setCat] = useState<BoardCat>("overall");
  const [board, setBoard] = useState<Board | null>(null);
  // Keeps the join view on screen while its success animation plays (the status flips to joined
  // as soon as the server answers); justJoined fades the list in afterwards.
  const [holdJoin, setHoldJoin] = useState(false);
  const [justJoined, setJustJoined] = useState(false);

  return (
    <div className="gm-pane lb">
      <p className="lb-sub">Everyone on Spechy this week. Resets every Monday at 00:00 UTC.</p>
      {state && (
        <>
          <div className="rk-top">
            <RankCard
              state={state}
              name={joined && status?.displayName ? status.displayName : "You"}
              title={state.equipped.title ?? null}
              rankLine={joined && board?.me?.rank != null ? <>Rank <b>#{board.me.rank}</b> this week</> : undefined}
              nums={[
                joined && board?.me
                  ? { value: fmtCoins(board.me.score), caption: CAPTION[cat] }
                  : { value: fmtCoins(state.rank.totalRp), caption: "rank points total" },
                { value: String(state.streak), caption: "day streak" },
              ]}
            />
            <PayoutCard joined={joined} payout={state.earnRates.weeklyPayout} />
          </div>
          <RankLadder state={state} />
        </>
      )}
      {status === null ? null : joined && !holdJoin ? (
        <div className={`lb-board ${justJoined ? "lb-enter" : ""}`}>
          <BoardList api={api} cat={cat} onCat={setCat} board={board} onBoard={setBoard} syncs={syncs}
            onLeft={() => { setBoard(null); setJustJoined(false); void refreshStatus(); toast({ kind: "success", message: "You left the leaderboard" }); }} />
        </div>
      ) : (
        <JoinView
          status={status}
          tier={state?.rank.tier ?? 0}
          comingSoon={!status.serverConfigured && (!import.meta.env.DEV || devComingSoon())}
          onStart={() => setHoldJoin(true)}
          onSettled={(ok) => {
            setHoldJoin(false);
            if (ok) { setJustJoined(true); void refreshStatus(); toast({ kind: "success", message: "You joined the leaderboard" }); }
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- list

function BoardList({ api, cat, onCat, board, onBoard, onLeft, syncs }: {
  api: LeaderboardApi; cat: BoardCat; onCat: (c: BoardCat) => void; syncs: number;
  board: Board | null; onBoard: (b: Board | null) => void; onLeft: () => void;
}) {
  const { toast } = useStore();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [avatars, setAvatars] = useState<Record<string, string | null>>({});
  const asked = useRef(new Set<string>());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Your own row shows the local picture at once (no download of your own upload).
  const [mine, setMine] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void api.getMyAvatar().then((u) => { if (alive) setMine(u); }, () => {});
    return () => { alive = false; };
  }, [api, syncs]);

  const load = useCallback(async (c: BoardCat) => {
    setLoading(true);
    setFailed(false);
    try {
      onBoard(await api.fetchBoard(c));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [api, onBoard]);
  useEffect(() => { void load(cat); }, [cat, load, syncs]);

  // Pictures only for rows that have one, once per player.
  useEffect(() => {
    for (const r of board?.rows ?? []) {
      if (r.me || !r.hasAvatar || asked.current.has(r.playerId)) continue;
      asked.current.add(r.playerId);
      api.fetchAvatar(r.playerId).then(
        (url) => setAvatars((a) => ({ ...a, [r.playerId]: url })),
        () => setAvatars((a) => ({ ...a, [r.playerId]: null })),
      );
    }
  }, [board, api]);

  const report = async (row: BoardRow, reason: "name" | "avatar") => {
    try {
      await api.report(row.playerId, reason);
      if (reason === "avatar") setHidden((h) => new Set(h).add(row.playerId));
      toast({ kind: "success", message: "Thanks, the report was sent" });
    } catch (e) {
      toast({ kind: "error", message: `Could not send the report. ${errText(e)}` });
    }
  };

  const leave = async () => {
    setLeaving(true);
    try {
      await api.leave();
      onLeft();
    } catch (e) {
      toast({ kind: "error", message: `Could not leave right now. ${errText(e)}` });
    } finally {
      setLeaving(false);
      setConfirmLeave(false);
    }
  };

  const rows = board?.rows ?? [];
  const meInList = rows.some((r) => r.me);
  const shown = board?.me && !meInList ? [...rows, board.me] : rows;

  return (
    <>
      <div className="lb-ctl">
        <div className="lb-seg" role="tablist" aria-label="Category">
          {CATS.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={cat === c.id} className={cat === c.id ? "on" : ""} onClick={() => onCat(c.id)}>
              {c.game ? <GameTitle game={c.game} size="tab" /> : c.label}
            </button>
          ))}
        </div>
      </div>
      <div className="lb-list rk-glass" aria-busy={loading}>
        <div className="lb-row lb-head" aria-hidden="true">
          <span className="lb-rk">#</span><span /><span>Name</span><span className="lb-score">{CAPTION[cat].replace(/^./, (m) => m.toUpperCase())}</span><span />
        </div>
        {failed ? (
          <div className="lb-msg">
            <span>Could not load the leaderboard.</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load(cat)}>Try again</button>
          </div>
        ) : shown.length === 0 ? (
          <div className="lb-msg"><span>{loading ? "Loading" : "Nobody has scored this week yet."}</span></div>
        ) : (
          shown.map((r, i) => (
            <LbRow
              key={`${r.playerId}-${i}`}
              row={r}
              gap={i > 0 && (r.rank == null || r.rank > (shown[i - 1].rank ?? 0) + 1)}
              avatar={r.me ? mine : hidden.has(r.playerId) ? null : avatars[r.playerId] ?? null}
              onReport={(why) => void report(r, why)}
            />
          ))
        )}
      </div>
      <div className="lb-foot">
        <ShieldCheck size={14} aria-hidden="true" />
        <span>Only your name, title, rank, weekly points, word count and bests are shared. Never your dictated text.</span>
        <span className="lb-foot-fill" />
        {confirmLeave ? (
          <span className="lb-leave-confirm">
            <span>Removes your name, scores and picture from the server.</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmLeave(false)} disabled={leaving}>Cancel</button>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => void leave()} disabled={leaving}>{leaving ? "Leaving" : "Leave"}</button>
          </span>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmLeave(true)}>
            <LogOut size={14} aria-hidden="true" />Leave leaderboard
          </button>
        )}
      </div>
    </>
  );
}

function LbRow({ row, gap, avatar, onReport }: { row: BoardRow; gap: boolean; avatar: string | null; onReport: (why: "name" | "avatar") => void }) {
  const [menu, setMenu] = useState(false);
  const close = useCallback(() => setMenu(false), []);
  const initial = [...row.name.trim()][0]?.toUpperCase() ?? "?";
  // A picture that fails to load falls back to the initial (no broken image icon).
  const [broken, setBroken] = useState<string | null>(null);
  const showImg = !!avatar && broken !== avatar;
  return (
    <div className={`lb-row ${row.me ? "me" : ""} ${gap ? "lb-gap" : ""}`}>
      <span className={`lb-rk ${row.rank != null && row.rank <= 3 ? `r${row.rank}` : ""}`}>{row.rank ?? ""}</span>
      <span className="lb-avatar" aria-hidden="true">{showImg ? <img src={avatar!} alt="" draggable={false} onError={() => setBroken(avatar)} /> : initial}</span>
      <span className="lb-who">
        <RankBadge tier={row.tier} division={null} size={22} />
        <span className="lb-name">{row.name}{row.me ? " (you)" : ""}</span>
        {row.title && <TitleTag title={row.title} />}
      </span>
      <span className="lb-score">{fmtCoins(row.score)}</span>
      <span className="lb-act menu-anchor">
        {!row.me && (
          <>
            <button type="button" className="lb-more" aria-label={`More for ${row.name}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
            <Menu open={menu} onClose={close}>
              <button type="button" className="menu-item" onClick={() => { close(); onReport("name"); }}>
                <Flag size={14} aria-hidden="true" />Report name
              </button>
              {row.hasAvatar && (
                <button type="button" className="menu-item" onClick={() => { close(); onReport("avatar"); }}>
                  <Flag size={14} aria-hidden="true" />Report picture
                </button>
              )}
            </Menu>
          </>
        )}
      </span>
    </div>
  );
}
