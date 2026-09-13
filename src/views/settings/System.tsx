import { useEffect, useRef, useState } from "react";
import { useStore } from "../../lib/store";
import { Toggle } from "../../components/ui";
import { Chord, Group, Row } from "./parts";

const PILL_MIN = 40;
const PILL_MAX = 150;

export default function SystemSection() {
  const { settings, update } = useStore();
  const [pillScale, setPillScale] = useState(settings.pillScale);
  const timer = useRef<number | null>(null);
  const dragging = useRef(false);

  // Keep the slider in sync with settings changed elsewhere, but never while dragging.
  useEffect(() => { if (!dragging.current) setPillScale(settings.pillScale); }, [settings.pillScale]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const onPillScale = (v: number) => {
    dragging.current = true;
    setPillScale(v);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { dragging.current = false; void update({ pillScale: v }); }, 150);
  };

  return (
    <>
      <Group label="App settings">
        <Row label="Launch app at login" sub="Start Spechy in the background when Windows starts.">
          <Toggle on={settings.launchAtLogin} onChange={(v) => void update({ launchAtLogin: v })} />
        </Row>
        <Row label="Show pill at all times" sub="Keep the floating pill visible, not only while dictating.">
          <Toggle on={settings.showPillAlways} onChange={(v) => void update({ showPillAlways: v })} />
        </Row>
        <Row label="Pill size" sub="How large the dictation pill appears on screen">
          <div className="set-slider">
            <input
              type="range"
              className="set-range"
              min={PILL_MIN}
              max={PILL_MAX}
              step={5}
              value={pillScale}
              aria-label="Pill size in percent"
              onChange={(e) => onPillScale(Number(e.target.value))}
            />
            <span className="set-slider-value">{pillScale}%</span>
          </div>
        </Row>
        <Row
          label="Dictation reminder"
          extra={<span className="set-hold set-hold-inline">Hold <Chord chord={settings.hotkeys.pushToTalk} /> to dictate</span>}
          sub="Shown in apps you have used Spechy in before."
        >
          <Toggle on={settings.dictationReminder} onChange={(v) => void update({ dictationReminder: v })} />
        </Row>
      </Group>

      <Group label="Sound">
        <Row label="Dictation and notification sounds" sub="A short chime when recording starts and stops.">
          <Toggle on={settings.sounds} onChange={(v) => void update({ sounds: v })} />
        </Row>
        <Row label="Live transcript in the pill" sub="Show the words while you speak instead of a plain waveform.">
          <Toggle on={settings.liveTranscript} onChange={(v) => void update({ liveTranscript: v })} />
        </Row>
      </Group>
    </>
  );
}
