// Title box parcels in flat style B (filled shapes, no outline): Basic is a Temu mailer bag,
// Premium an Amazon box, Mythic an NVIDIA DGX Spark box. TS port of style B from
// _dev/mockups/social-shop/package-art.js (PKG_ART.B and PKG_OPEN). Fixed colours are allowed
// here: this is illustration art inside views/games. Logos are the official vector paths:
// temu selfhst-temu.svg (selfh.st icons), amazon Simple Icons 9.21.0, nvidia svgl wordmark.
import type { BoxId } from "../../../lib/ipc";

const LOGO = {
  // Temu: orange rounded square with the glyphs cut out; a white rect behind it fills the glyphs (viewBox 512)
  temu: "M398.2 0C461.1 0 512 51 512 113.8v284.4c0 62.9-51 113.8-113.8 113.8H113.8C51 512 0 461 0 398.2V113.8C0 51 51 0 113.8 0zm-128 266h-6.8c-6 0-11 4.9-11 11v75.2c0 6 4.9 11 11 11s11-4.9 11-11v-49.4l18.5 26.1c3.9 5.4 11.9 5.4 15.8 0l18.5-26.1v49.4c0 6 4.9 11 11 11c6 0 11-4.9 11-11V277c0-6-4.9-11-11-11h-6.8c-2.6 0-5.1 1.2-6.6 3.4l-24 36l-24-36c-1.5-2.2-3.9-3.4-6.6-3.4m170.1 0c-6 0-11 4.9-11 11v46c0 14.5-8.1 21.9-21.5 21.8c-13.4 0-21.5-7.6-21.5-22.5V277c0-6-4.9-11-11-11c-6 0-11 4.9-11 11v45.8c0 26.8 16.4 40.5 43.2 40.5s43.8-13.5 43.8-41.1v-45.1c0-6.200-4.9-11.2-11-11.1m-308.4 0H67.7c-6 0-11 4.9-11 11c0 6 4.9 11 11 11h21.1v64.1c0 6 4.9 11 10.9 11c6.1 0 11-4.9 11-11V288h21.1c6 0 11-4.9 11-11c.1-6.1-4.8-11.1-10.9-11m94.9 0h-59.4c-6.1 0-11 4.9-11 11v75.1c0 6 4.9 11 11 11h59.4c6.1 0 11-4.9 11-11c0-6-4.9-11-11-11h-48.5v-15.6h42.2c6 0 11-4.9 11-11c0-6-4.9-11-11-11h-42.2v-15.6h48.5c6.1 0 11-4.9 11-11c0-6-4.9-11-11-10.9M119.5 151.3l-2.1.1c-8.6.6-14.4 4.2-17.7 9.2c-3.8-5.8-11.1-9.8-21.900-9.2l-.2.4c-1.2 2-5.9 10.9 1.7 20.7c1.6 1.6 5.3 6.3 3.8 12.2l-22 35.6c-1.8 2.9-1 6.6 1.8 8.6c5.7 4 17.1 9.5 37 9.5c19.8 0 31.2-5.5 37-9.5l.8-.6c2.1-2.1 2.6-5.4 1-7.9l-22-35.7l.2.6l-.2-1c-1.2-5.4 1.8-9.6 3.4-11.5l.4-.4c7.7-9.8 2.9-18.6 1.700-20.700l-.2-.4zM191 168c-7.6-15-17.4-17.6-22.2-13.6c-3.8 3-12.4 14.9-13 15.6c-9.6 13.6-9 16.9 3.2 24.6c6.9 4.4 12.4-1.2 14.9-2.9c-1.1 7.1-4.6 18.4-9.9 26.3c-2.9-2.1-5-3.8-6.2-5c-1.6-1.5-4.1-1.4-5.8.1c-.8.8-1.1 1.8-1.1 2.9s.5 2.1 1.2 2.8c12.8 11.6 29.5 18.2 47.4 18.3c17.9 0 34.8-6.6 47.5-18.3c1.6-1.5 1.7-4 .2-5.6c-1.6-1.6-4.1-1.6-5.8-.1c-1 .9-2 1.8-3 2.6l-5.6-12.5c-.9-2.1-1.9-4.9-3-8.1c.5-1.4 1.7-2.6 3.4-4.4c1.2-1.2 2.2-2.4 2.9-3.6c3.7-5.9 1.6-9.3.5-11.6c-2.6-5.4-6.8-3.6-9.8-.4c-3.7 3.9-7.3 5.6-13.1 6.9c-4.9 1.1-8.6.6-11.7-1.4c-4.5-2.8-11-12.6-11-12.6m138.6-15.3c-16 15.2-.6 48.2-29.8 62.3c-3.2 1.6-5.9-3.6-10.1-3.6c-12.1.1-35.4 10.8-36.2 16.2c-.8 4.4 9.1 8 38.4 8.1c25.4 0 33.6-38.6 42.5-38.7c8.9 0 4.8 35.1 3.8 38.7h9.3c-.8-3.6-1.4-14.6-1.4-30.2s2.8-19 5-30.8c1.9-10.1-13.2-19-21.5-22m91.2 1.3h-26c-16.9 0-30.9 13.1-32 29.9l-1.9 26.9c-.9 12.8 9.2 23.6 22 23.7h49.7c12.9 0 23-10.9 22.1-23.7l-1.9-26.9c-1.2-16.9-15.1-29.9-32-29.9m-221.3 62c7.9 0 13.9 3.9 16.1 11c-5.4 1.4-10.7 2.1-16.1 2.1c-8.2 0-11.1-.8-16.4-2.1c2-6.4 9-11 16.4-11m196.4-39.7v.8c0 6.5 5.3 11.9 11.8 11.9s11.9-5.3 11.9-11.9v-.8c0-2.9 10.5-2.9 10.5 0v.8c0 12.3-10 22.3-22.4 22.3c-12.3 0-22.3-10-22.3-22.3v-.8c0-2.9 10.5-2.9 10.5 0",
  // Amazon (viewBox 24): "a" plus smile arrow; on boxes only the smile is printed, so it is clipped to y > 16.9
  amazon: "M.045 18.02c.072-.116.187-.124.348-.022 3.636 2.11 7.594 3.166 11.87 3.166 2.852 0 5.668-.533 8.447-1.595l.315-.14c.138-.06.234-.1.293-.13.226-.088.39-.046.525.13.12.174.09.336-.12.48-.256.19-.6.41-1.006.654-1.244.743-2.64 1.316-4.185 1.726a17.617 17.617 0 01-10.951-.577 17.88 17.88 0 01-5.43-3.35c-.1-.074-.151-.15-.151-.22 0-.047.021-.09.051-.13zm6.565-6.218c0-1.005.247-1.863.743-2.577.495-.71 1.17-1.25 2.040-1.615.796-.335 1.756-.575 2.912-.72.39-.046 1.033-.103 1.92-.174v-.37c0-.93-.105-1.558-.3-1.875-.302-.43-.78-.65-1.44-.65h-.182c-.48.046-.896.196-1.246.46-.35.27-.575.63-.675 1.096-.06.3-.206.465-.435.51l-2.52-.315c-.248-.06-.372-.18-.372-.39 0-.046.007-.09.022-.15.247-1.29.855-2.25 1.820-2.88.976-.616 2.1-.975 3.39-1.05h.54c1.650 0 2.957.434 3.888 1.29.135.15.27.3.405.48.12.165.224.314.283.45.075.134.15.33.195.57.06.254.105.42.135.51.03.104.062.3.076.615.01.313.02.493.02.553v5.28c0 .376.06.72.165 1.036.105.313.21.54.315.674l.51.674c.09.136.136.256.136.36 0 .12-.06.226-.18.314-1.2 1.05-1.86 1.62-1.963 1.71-.165.135-.375.15-.63.045a6.062 6.062 0 01-.526-.496l-.31-.347a9.391 9.391 0 01-.317-.42l-.3-.435c-.81.886-1.603 1.44-2.4 1.665-.494.15-1.093.227-1.83.227-1.11 0-2.04-.343-2.76-1.034-.72-.69-1.08-1.665-1.08-2.94l-.05-.076zm3.753-.438c0 .566.14 1.02.425 1.364.285.34.675.512 1.155.512.045 0 .106-.007.195-.02.09-.016.134-.023.166-.023.614-.16 1.08-.553 1.424-1.178.165-.28.285-.58.36-.91.09-.32.12-.59.135-.8.015-.195.015-.54.015-1.005v-.54c-.84 0-1.484.06-1.92.18-1.275.36-1.92 1.17-1.92 2.43l-.035-.02zm9.162 7.027c.03-.06.075-.11.132-.17.362-.243.714-.41 1.05-.5a8.094 8.094 0 011.612-.24c.14-.012.28 0 .41.03.65.06 1.05.168 1.172.33.063.09.099.228.099.39v.15c0 .51-.149 1.11-.424 1.8-.278.69-.664 1.248-1.156 1.68-.073.06-.14.09-.197.09-.03 0-.06 0-.09-.012-.09-.044-.107-.12-.064-.24.54-1.26.806-2.143.806-2.64 0-.15-.03-.27-.087-.344-.145-.166-.55-.257-1.224-.257-.243 0-.533.016-.87.046-.363.045-.7.09-1 .135-.09 0-.148-.014-.18-.044-.03-.03-.036-.047-.02-.077 0-.017.006-.03.02-.063v-.06z",
  // NVIDIA wordmark (viewBox 164 x 30): eye in its square, and the NVIDIA letters (registered mark dropped)
  nvEye: "M16.889 8.985V6.28c.262-.02.528-.033.798-.042 7.4-.232 12.255 6.359 12.255 6.359s-5.244 7.282-10.866 7.282a6.83 6.83 0 0 1-2.187-.35v-8.204c2.88.348 3.46 1.62 5.192 4.508l3.852-3.248s-2.812-3.688-7.552-3.688c-.515 0-1.008.036-1.492.088Zm0-8.938V4.09c.265-.021.531-.038.798-.048 10.29-.346 16.995 8.44 16.995 8.44s-7.7 9.364-15.723 9.364c-.735 0-1.424-.068-2.07-.183v2.498c.553.07 1.126.112 1.724.112 7.465 0 12.864-3.812 18.092-8.325.867.694 4.416 2.383 5.145 3.123-4.971 4.16-16.555 7.515-23.123 7.515a18.807 18.807 0 0 1-1.838-.096V30h28.375V.047H16.889Zm0 19.482v2.133c-6.905-1.23-8.822-8.408-8.822-8.408s3.316-3.674 8.822-4.269v2.34l-.011-.001c-2.89-.347-5.147 2.353-5.147 2.353s1.265 4.544 5.158 5.852ZM4.625 12.943s4.092-6.04 12.264-6.663V4.088C7.838 4.815 0 12.48 0 12.48s4.439 12.833 16.889 14.008V24.16C7.753 23.011 4.625 12.943 4.625 12.943Z",
  nvWord: "M96.374 5.707l.002 19.66h5.552V5.707h-5.554Zm-43.677-.026v19.686H58.3V10.086l4.37.014c1.437 0 2.43.345 3.123 1.084.879.936 1.237 2.444 1.237 5.205v8.978h5.427V14.49c0-7.763-4.948-8.81-9.789-8.81h-9.97l-.001.001Zm52.617.027v19.659h9.006c4.798 0 6.364-.798 8.057-2.587 1.198-1.256 1.971-4.014 1.971-7.027 0-2.763-.655-5.228-1.797-6.763-2.057-2.745-5.020-3.282-9.445-3.282h-7.792Zm5.508 4.28h2.387c3.463 0 5.703 1.556 5.703 5.591 0 4.037-2.24 5.592-5.703 5.592h-2.387V9.988Zm-22.453-4.28-4.634 15.580-4.44-15.579-5.993-.001 6.34 19.659h8.003l6.391-19.659h-5.667Zm38.563 19.659h5.553V5.709l-5.555-.001.002 19.659Zm15.564-19.652-7.753 19.645h5.475l1.227-3.472h9.175l1.161 3.472h5.944l-7.812-19.646-7.417.001ZM146.1 9.3l3.364 9.204h-6.833l3.47-9.204h-.001Z",
};

const INK = "#151312";
type Pt = [number, number];
let uid = 0;
const pts = (a: Pt[]) => a.map((p) => p.join(",")).join(" ");
const anim = (x: number, y: number) => `style="transform-box:view-box;transform-origin:${x}px ${y}px"`;
const attrs = (o: Record<string, string | number>) => Object.entries(o).map(([k, v]) => `${k}="${v}"`).join(" ");
const shape = (tag: string, a: Record<string, string | number>, fill: string) => `<${tag} ${attrs(a)} fill="${fill}"/>`;
const line = (d: string, color: string) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;

/* ---------- Basic: Temu poly mailer bag */
function temu(): string {
  const P = { base: "#fb7701", light: "#ff9a3d", dark: "#d65f00", deep: "#6e2e00", pattern: "#f06f00", panel: "#ff9a3d" };
  const id = `pk${++uid}`;
  const zig: Pt[] = [];
  for (let x = 36, i = 0; x <= 164; x += 8, i++) zig.push([x, i % 2 ? 56 : 50]);
  const body = pts([...zig, [166, 82], [163, 112], [167, 142], [164, 170], [162, 187], [138, 189], [112, 185], [84, 189], [58, 186], [37, 188], [36, 160], [39, 130], [35, 100], [38, 74]]);
  const strip: Pt[] = [[37, 30], [70, 32], [100, 28], [131, 31], [163, 29], ...zig.slice().reverse()];
  let pattern = "";
  for (let r = 0, y = 70; y < 192; y += 13, r++) {
    for (let x = r % 2 ? 22 : 40; x < 180; x += 36) pattern += `<text x="${x}" y="${y}">TEMU</text>`;
  }
  pattern = `<g clip-path="url(#${id}b)" fill="${P.pattern}" font-family="Inter,Segoe UI,sans-serif" font-weight="700" font-size="9" letter-spacing=".5">${pattern}</g>`;
  const creases = `<g clip-path="url(#${id}b)">
      <polygon points="${pts([[30, 98], [74, 110], [30, 120]])}" fill="${P.dark}"/>
      <polygon points="${pts([[170, 124], [128, 129], [170, 150]])}" fill="${P.dark}"/>
      <polygon points="${pts([[70, 192], [96, 172], [110, 192]])}" fill="${P.dark}"/>
      <polygon points="${pts([[30, 150], [52, 158], [30, 170]])}" fill="${P.dark}"/>
      <polygon points="${pts([[30, 50], [170, 50], [170, 66], [30, 64]])}" fill="${P.light}"/>
    </g>`;
  const L = 74, lx = 100 - L / 2, ly = 82, k = L / 512;
  const logo = `<g transform="translate(${lx} ${ly}) scale(${k})">
      <rect x="42" y="40" width="422" height="422" fill="#ffffff"/>
      <path d="${LOGO.temu}" fill="${P.panel}"/>
    </g>`;
  return `<defs><clipPath id="${id}b"><polygon points="${body}"/></clipPath></defs>
    <g class="pkg-body" ${anim(100, 188)}>
      ${shape("polygon", { points: body }, P.base)}
      ${pattern}${creases}
      <g class="pkg-in" style="opacity:0"><polygon points="${pts([...zig, [164, 66], [130, 62], [100, 67], [70, 62], [36, 66]])}" fill="${P.deep}"/></g>
      ${logo}
    </g>
    <g class="pkg-strip" ${anim(36, 40)}>
      ${shape("polygon", { points: pts(strip) }, P.light)}
      <polygon points="${pts([[37, 30], [70, 32], [100, 28], [131, 31], [163, 29], [163, 36], [37, 37]])}" fill="${P.base}"/>
      ${line("M44 43 L156 43", P.dark)}
    </g>`;
}

/* ---------- the cardboard box shared by Premium and Mythic: top face with two side flaps, front face */
interface BoxGeo { x0: number; x1: number; yt: number; yf: number; yb: number }
interface BoxPal { top: string; front: string; dark: string; deep: string; inside: string }
type FlapExtra = (side: "l" | "r", xa: number, xb: number) => string;

function box(g: BoxGeo, P: BoxPal, flapExtra: FlapExtra, frontExtra: string): string {
  const { x0, x1, yt, yf, yb } = g, xm = (x0 + x1) / 2;
  const flap = (side: "l" | "r") => {
    const l = side === "l", xa = l ? x0 : xm, xb = l ? xm : x1;
    return `<g class="pkg-lid pkg-lid-${side}" data-hinge="${l ? x0 : x1},${yf}">
      ${shape("rect", { x: xa, y: yt, width: xb - xa, height: yf - yt }, P.top)}
      <g class="pkg-lid-inside" style="opacity:0">${shape("rect", { x: xa, y: yt, width: xb - xa, height: yf - yt }, P.inside)}</g>
      ${flapExtra(side, xa, xb)}
    </g>`;
  };
  return `<g class="pkg-body" ${anim(100, yb)}>
      <g class="pkg-in" style="opacity:0">${shape("rect", { x: x0, y: yt, width: x1 - x0, height: yf - yt }, P.deep)}</g>
      ${shape("rect", { x: x0, y: yf, width: x1 - x0, height: yb - yf }, P.front)}
      <rect x="${x0}" y="${yb - 7}" width="${x1 - x0}" height="7" fill="${P.dark}"/>
      ${frontExtra}
    </g>${flap("l")}${flap("r")}`;
}

const tapeOnFlap = (g: BoxGeo, tx: number, tw: number, color: string): FlapExtra => (_side, xa, xb) => {
  const a = Math.max(xa, tx), b = Math.min(xb, tx + tw);
  return `<rect x="${a}" y="${g.yt}" width="${b - a}" height="${g.yf - g.yt}" fill="${color}"/>`;
};

/* ---------- Premium: Amazon box with prime tape, smile and shipping label */
function amazon(): string {
  const P = { top: "#e2b47a", front: "#c8915a", dark: "#a8743f", deep: "#4f3017", inside: "#b9834c", tape: "#1a98e0", label: "#f4f1ea", ink: INK };
  const id = `pk${++uid}`;
  const g = { x0: 20, x1: 180, yt: 64, yf: 90, yb: 184 };
  const tw = 18, tx = 100 - tw / 2;
  const smile = `<g transform="translate(30 76) scale(3.4)"><path d="${LOGO.amazon}" clip-path="url(#${id}s)" fill="${P.ink}"/></g>`;
  const lx = 122, ly = 104, lw = 48, lh = 46;
  const bars = [0, 3, 5, 9, 11, 14, 18, 20, 23, 27, 29, 32, 34, 37]
    .map((x, i) => `<rect x="${lx + 6 + x}" y="${ly + 28}" width="${i % 3 ? 1.6 : 2.6}" height="11" fill="${P.ink}"/>`).join("");
  const label = `${shape("rect", { x: lx, y: ly, width: lw, height: lh, rx: 3 }, P.label)}
     <rect x="${lx + 6}" y="${ly + 7}" width="26" height="4" rx="1" fill="${P.ink}"/>
     <rect x="${lx + 6}" y="${ly + 15}" width="18" height="3" rx="1" fill="#9a958c"/>
     <rect x="${lx + 6}" y="${ly + 21}" width="22" height="3" rx="1" fill="#9a958c"/>${bars}`;
  const tapeFront = shape("rect", { x: tx, y: g.yf, width: tw, height: 26 }, P.tape);
  return `<defs><clipPath id="${id}s" clipPathUnits="userSpaceOnUse"><rect x="-1" y="16.9" width="26" height="8"/></clipPath></defs>
    ${box(g, P, tapeOnFlap(g, tx, tw, P.tape), tapeFront + smile + label)}`;
}

/* ---------- Mythic: NVIDIA DGX Spark box, plain kraft with the green NVIDIA band */
function dgx(): string {
  const P = { top: "#dcb07c", front: "#c2915b", dark: "#9d6f3e", deep: "#4a2f17", inside: "#b4844f", tape: "#b98a55", green: "#76b900", ink: "#0e0e0e" };
  const g = { x0: 34, x1: 166, yt: 52, yf: 80, yb: 184 };
  const tw = 18, tx = 100 - tw / 2;
  const tapeFront = shape("rect", { x: tx, y: g.yf, width: tw, height: 14 }, P.tape);
  const by = 104, bh = 56;
  const band = `${shape("rect", { x: g.x0, y: by, width: g.x1 - g.x0, height: bh }, P.green)}
    <g transform="translate(${100 - (164 * 0.66) / 2} ${by + 10}) scale(.66)" fill="${P.ink}"><path d="${LOGO.nvEye}"/><path d="${LOGO.nvWord}"/></g>
    <text x="100" y="${by + 47}" text-anchor="middle" font-family="Inter,Segoe UI,sans-serif" font-weight="700" font-size="17" letter-spacing="-.2" fill="${P.ink}">DGX Spark</text>`;
  return box(g, P, tapeOnFlap(g, tx, tw, P.tape), tapeFront + band);
}

const BUILD: Record<BoxId, () => string> = { basic: temu, premium: amazon, mythic: dgx };
const TILT: Record<BoxId, number> = { basic: -2, premium: 0, mythic: 0 };

/** Trim colour of each parcel, for the burst when it opens. */
export const PARCEL_TRIM: Record<BoxId, string> = { basic: "#fb7701", premium: "#ff9900", mythic: "#76b900" };

/** The parcel as an HTML string (a sized wrapper with an inline SVG). */
export function parcelHtml(boxId: BoxId, size: number): string {
  const s = Math.round(size);
  return `<div class="pkg pkg-B pkg-${boxId}" data-box="${boxId}" style="position:relative;display:inline-block;width:${s}px;height:${s}px;transform-origin:50% 92%">
    <svg viewBox="0 0 200 200" width="${s}" height="${s}" overflow="visible" style="display:block;overflow:visible" aria-hidden="true">
      <g transform="rotate(${TILT[boxId]} 100 186)">${BUILD[boxId]()}</g></svg></div>`;
}

function rootOf(el: Element): HTMLElement | null {
  return el.classList.contains("pkg") ? (el as HTMLElement) : el.querySelector<HTMLElement>(".pkg");
}

/** Put a parcel back to closed. */
export function resetParcel(el: Element) {
  const root = rootOf(el);
  if (!root) return;
  root.getAnimations({ subtree: true }).forEach((a) => a.cancel());
  root.querySelectorAll(".pkg-lid").forEach((l) => l.removeAttribute("transform"));
}

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Open a parcel: an optional rattle (1.15 s), then about 650 ms of tear (bag) or flaps (boxes).
 *  Pass `shake: false` when the caller shakes the parcel itself. */
export async function openParcel(el: Element, boxId?: BoxId, opts: { shake?: boolean } = {}): Promise<void> {
  const root = rootOf(el);
  if (!root) return;
  const id = (boxId ?? root.dataset.box) as BoxId;
  const reduce = reducedMotion();
  resetParcel(root);
  const S = parseFloat(root.style.width) || 170;
  if (opts.shake !== false && !reduce) {
    await root.animate(
      [0, -1, 1, -2, 2, -3, 3, -4, 4, -2, 0].map((r, i) => ({ transform: `rotate(${r}deg) translateY(${-i * S * 0.002}px) scale(${1 + i * 0.004})` })),
      { duration: 1150, easing: "ease-in" },
    ).finished.catch(() => {});
  }
  const dur = reduce ? 1 : 650;
  root.querySelector(".pkg-in")?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduce ? 1 : 90, fill: "forwards" });
  root.querySelector(".pkg-body")?.animate(
    [{ transform: "none" }, { transform: "scale(1.04, .95)" }, { transform: "scale(.99, 1.02)" }, { transform: "none" }],
    { duration: reduce ? 1 : 420, easing: "ease-out" },
  );
  if (id === "basic") {
    // the seal strip catches on the left, then rips off and flies away to the upper right
    const strip = root.querySelector(".pkg-strip");
    if (!strip) return;
    await strip.animate([
      { transform: "none", opacity: 1, offset: 0 },
      { transform: "translate(0px, -3px) rotate(-5deg)", opacity: 1, offset: 0.2 },
      { transform: "translate(18px, -26px) rotate(10deg)", opacity: 1, offset: 0.45 },
      { transform: "translate(56px, -70px) rotate(28deg)", opacity: 1, offset: 0.75 },
      { transform: "translate(80px, -96px) rotate(38deg)", opacity: 0, offset: 1 },
    ], { duration: dur, easing: "cubic-bezier(.3,.6,.35,1)", fill: "forwards" }).finished.catch(() => {});
    return;
  }
  // A flap turns on its outer edge: the hinge stays put, the flap width swings up and out.
  // That is a projected matrix, not a 2D rotation, so a timing-only animation drives it per frame.
  const open = (lid: SVGGElement, dir: number, delay: number) => {
    const px = Number((lid.dataset.hinge ?? "0,0").split(",")[0]), MAX = 124;
    const ins = lid.querySelector<SVGGElement>(".pkg-lid-inside");
    const timer = lid.animate([{ opacity: 1 }, { opacity: 1 }], { duration: dur, delay: reduce ? 0 : delay, easing: "cubic-bezier(.3,.7,.35,1.12)", fill: "forwards" });
    const set = () => {
      const p = timer.effect?.getComputedTiming().progress;
      const t = p ?? (timer.playState === "finished" ? 1 : 0);
      const th = (t * MAX * Math.PI) / 180, a = Math.cos(th), b = -dir * Math.sin(th);
      lid.setAttribute("transform", `matrix(${a} ${b} 0 1 ${px - a * px} ${-b * px})`);
      if (ins) ins.style.opacity = th > Math.PI / 2 ? "1" : "0";
    };
    const tick = () => {
      if (!lid.isConnected || timer.playState === "idle") return;
      set();
      if (timer.playState !== "finished") requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return timer.finished.then(set, () => {});
  };
  const lids = Array.from(root.querySelectorAll<SVGGElement>(".pkg-lid"));
  if (lids.length < 2) return;
  await Promise.all([open(lids[0], 1, 0), open(lids[1], -1, 70)]);
}
