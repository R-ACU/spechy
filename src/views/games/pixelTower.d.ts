// Types for pixelTower.js (plain JS game module, see the header there).

export interface PixelTowerOptions {
  bot?: boolean;
  muted?: boolean;
  onScore?: (score: number) => void;
  onGameOver?: (result: { score: number; best: number; newBest: boolean }) => void;
  /** localStorage key of the best score; mute state goes to `${storageKey}.muted`. */
  storageKey?: string;
  /** Internal pixels across the shorter side of the canvas. */
  shortSide?: number;
  /** Hide the game's own game over HUD (the app shows a results card). */
  appResults?: boolean;
  /** Element that receives keydown listeners. Default: window. */
  keyTarget?: EventTarget;
  reducedMotion?: boolean;
  /** Sound volume 0..1; default: the remembered value or 0.8. */
  volume?: number;
  /** Spechy shop skin: "sunset" gives sunset-toned blocks. Default: the original colours. */
  skin?: "sunset" | null;
}

export interface TowerSwatch { top: string; left: string; right: string; rim: string }
/** Face colours (CSS) of `count` consecutive blocks, for the shop preview. */
export function towerSkinSwatches(skin: "sunset" | null, count: number, offset?: number): TowerSwatch[];

export interface PixelTowerState {
  state: "title" | "play" | "dying" | "over";
  score: number;
  best: number;
  combo: number;
  muted: boolean;
}

export interface PixelTowerGame {
  tap(): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  /** Sound volume 0..1, remembered in `${storageKey}.volume`. */
  setVolume(volume: number): void;
  getVolume(): number;
  setBot(bot: boolean): void;
  getState(): PixelTowerState;
  /** Stops the frame loop, removes every listener and closes the AudioContext. */
  destroy(): void;
}

export function create(canvas: HTMLCanvasElement, opts?: PixelTowerOptions): PixelTowerGame;
export function createSfx(ac: AudioContext, out?: AudioNode): Record<string, (arg?: unknown) => void>;
