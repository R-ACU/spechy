// Developer tools for the Games economy. Dev builds only: Settings imports this file behind
// import.meta.env.DEV, and the backend commands refuse to work in release builds. No coin
// balance here on purpose: the balance only appears inside Games.
import { useEffect, useState } from "react";
import { displayedBalance, economyDev, economySnapshot, holdBalance, loadEconomy, useEconomy } from "../../lib/economy";
import { holdRankWatch, markRankSeen, showRankUp } from "../games/rank/rankHost";
import type { BoxId } from "../../lib/ipc";
import { useStore } from "../../lib/store";
import { Button, Toggle } from "../../components/ui";
import { Group, Row } from "./parts";

const BOX_NAMES: [BoxId, string][] = [["basic", "Basic"], ["premium", "Premium"], ["mythic", "Mythic"]];

export default function Developer() {
  const { toast, settings } = useStore();
  const { state } = useEconomy();
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => { void loadEconomy().catch(() => {}); }, []);

  if (!economyDev) return null;
  const dev = economyDev;
  const run = async (what: () => Promise<unknown>, ok: string) => {
    try {
      await what();
      if (ok) toast({ kind: "success", message: ok });
    } catch (e) {
      toast({ kind: "error", message: String(e) });
    }
  };

  return (
    <>
      <Group label="Games economy">
        <Row label="Unlimited coins" sub="Purchases do not reduce the balance. The coin chip in Games shows the real number with an Unlimited marker.">
          <Toggle
            on={!!state?.unlimited}
            label="Unlimited coins"
            onChange={(on) => void run(() => dev.setUnlimited(on), on ? "Unlimited coins on" : "Unlimited coins off")}
          />
        </Row>
        <Row label="Add coins" sub="Adds 10,000 coins, recorded in the ledger as developer coins.">
          <Button variant="secondary" size="sm" onClick={() => void run(() => dev.addCoins(10_000), "Added 10,000 coins")}>Add 10,000</Button>
        </Row>
        <Row label="Simulate a rank up" sub="Adds exactly the rank points for the next division and pays its rewards.">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void run(async () => {
              // Show the real rank-up overlay; the watcher must not show it a second time, and the
              // coin chip waits for Collect.
              const release = holdRankWatch();
              const before = economySnapshot();
              holdBalance(before.state ? displayedBalance(before) : null);
              try {
                const r = await dev.rankUp();
                markRankSeen(r.state.rank);
                // Reserves the promotion coins off the chip; Collect flies them in.
                if (r.promotions.length) showRankUp(r.promotions, { sound: settings.sounds !== false, holdCoins: true });
              } finally {
                holdBalance(null);
                release();
              }
            }, "")}
          >
            Rank up
          </Button>
        </Row>
        <Row label="Grant box keys" sub="One free opening of the chosen title box.">
          <div className="dev-keys">
            {BOX_NAMES.map(([id, name]) => (
              <Button key={id} variant="secondary" size="sm" onClick={() => void run(() => dev.grantKeys(id, 1), `${name} key added`)}>
                {name}
              </Button>
            ))}
          </div>
        </Row>
        <Row label="Reset economy" sub="Deletes coins, ledger, rank, items, keys and daily counters. Cannot be undone.">
          {confirmReset ? (
            <div className="dev-keys">
              <Button variant="secondary" size="sm" onClick={() => setConfirmReset(false)}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={() => { setConfirmReset(false); void run(() => dev.reset(), "Economy reset"); }}>Confirm reset</Button>
            </div>
          ) : (
            <Button variant="danger" size="sm" onClick={() => setConfirmReset(true)}>Reset</Button>
          )}
        </Row>
      </Group>
      <p className="set-row-sub muted dev-note">Only in development builds. None of this exists in a release build.</p>
    </>
  );
}
