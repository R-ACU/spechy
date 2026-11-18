//! The floating status pill: a native layered Win32 window at the bottom center
//! of the primary monitor. It never takes focus, is drawn with per-pixel alpha
//! through UpdateLayeredWindow and rasterizes its shapes itself (signed distance
//! fields) so every edge comes out anti-aliased.
//!
//! Look: small and discreet, about 195 x 52 px at 100 % DPI. The body is a dark
//! translucent glass capsule (the desktop shows through slightly), with a bright
//! rim highlight at the top left fading out to the bottom right and a soft outer
//! shadow. With a live transcript the pill does not open a second bubble, it
//! grows upward into one continuous rounded window with the text on top and the
//! button row at the bottom.
#![cfg_attr(not(windows), allow(dead_code))]

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, PartialEq)]
pub enum PillState {
    Hidden,
    /// Small collapsed capsule when the user wants the pill on screen always.
    Idle,
    Recording {
        level: f32,
        live_text: String,
    },
    Processing,
    Error {
        message: String,
        /// The whole pill is clickable and retries the failed dictation.
        retry: bool,
    },
    Done,
}

impl Default for PillState {
    fn default() -> Self {
        PillState::Hidden
    }
}

// ------------------------------------------------------------------ geometry
// All values are for 100 % DPI and get multiplied by the monitor scale.

const PILL_WIDTH: f32 = 195.0;
const PILL_HEIGHT: f32 = 52.0;
const IDLE_WIDTH: f32 = 110.0;
const IDLE_HEIGHT: f32 = 26.0;
const SIDE_PADDING: f32 = 11.0;
const BUTTON_RADIUS: f32 = 15.0;
const DOT_RADIUS: f32 = 1.75;
const DOT_RADIUS_MAX: f32 = 3.5;
const DOT_SPACING: f32 = 7.5;
const PANEL_RADIUS: f32 = 22.0;
const TEXT_PADDING: f32 = 16.0;
const PANEL_MAX_WIDTH: f32 = 440.0;
const TEXT_SIZE: f32 = 14.0;
const TEXT_LINE_HEIGHT: f32 = 19.0;
const TEXT_MAX_LINES: f32 = 5.0;
/// Room around the shape for the soft outer shadow.
const SHADOW_MARGIN: f32 = 16.0;
const SHADOW_OFFSET_Y: f32 = 4.0;
/// Distance between the bottom of the pill and the bottom of the work area.
const BOTTOM_OFFSET: f32 = 48.0;
/// User size in percent of the base look.
const DEFAULT_SCALE_PERCENT: u32 = 70;
const MIN_SCALE_PERCENT: u32 = 40;
const MAX_SCALE_PERCENT: u32 = 150;

// ------------------------------------------------------------------ colors

/// Glass body: near black, slightly lighter at the top (gloss), alpha below.
const GLASS_TOP: [f32; 3] = [0.102, 0.102, 0.113];
const GLASS_BOTTOM: [f32; 3] = [0.063, 0.063, 0.071];
const GLASS_ALPHA: f32 = 0.80;
const GLASS_ERROR_TOP: [f32; 3] = [0.330, 0.150, 0.150];
const GLASS_ERROR_BOTTOM: [f32; 3] = [0.250, 0.100, 0.100];
/// Rim highlight, bright at the top left and faint at the bottom right.
const RIM_ALPHA_NEAR: f32 = 0.35;
const RIM_ALPHA_FAR: f32 = 0.08;
const RIM_THICKNESS: f32 = 1.5;
const CANCEL_CIRCLE: [f32; 3] = [0.290, 0.290, 0.290]; // #4a4a4a
const WHITE: [f32; 3] = [1.0, 1.0, 1.0];
const BLACK: [f32; 3] = [0.05, 0.05, 0.05];

// ------------------------------------------------------------------ skins
// Pill skins from the shop (equip slot "pill"). A skin only tints the level
// dots while recording; body, rim, buttons and the other states stay as they
// are. Keep in sync with `src/views/games/shop/pillSkins.ts`.

/// Shop item id and its accent color as 0xRRGGBB.
pub const PILL_SKINS: [(&str, u32); 3] = [
    ("pill-amber", 0xe8b44a),
    ("pill-mint", 0x4fd8a4),
    ("pill-coral", 0xf0736f),
];

/// Accent color of the equipped skin; 0 means no skin (default white dots).
/// Bit 24 marks "set" so black could never be confused with "none".
static SKIN_ACCENT: AtomicU32 = AtomicU32::new(0);
const SKIN_SET: u32 = 1 << 24;

/// The accent color for a pill skin item, `None` for unknown ids or no skin.
pub fn skin_accent(item_id: Option<&str>) -> Option<[f32; 3]> {
    let id = item_id?;
    PILL_SKINS
        .iter()
        .find(|(skin, _)| *skin == id)
        .map(|(_, rgb)| rgb_to_color(*rgb))
}

fn rgb_to_color(rgb: u32) -> [f32; 3] {
    [
        ((rgb >> 16) & 0xff) as f32 / 255.0,
        ((rgb >> 8) & 0xff) as f32 / 255.0,
        (rgb & 0xff) as f32 / 255.0,
    ]
}

/// Sets the equipped pill skin. Cheap (one atomic store), safe from any
/// thread; the recording dots animate every frame, so no repaint is needed.
pub fn set_skin(item_id: Option<&str>) {
    let packed = item_id
        .and_then(|id| PILL_SKINS.iter().find(|(skin, _)| *skin == id))
        .map(|(_, rgb)| SKIN_SET | rgb)
        .unwrap_or(0);
    SKIN_ACCENT.store(packed, Ordering::Relaxed);
}

/// Color of the recording dots: the skin accent or the default white.
fn recording_dot_color() -> [f32; 3] {
    let packed = SKIN_ACCENT.load(Ordering::Relaxed);
    if packed & SKIN_SET == 0 {
        WHITE
    } else {
        rgb_to_color(packed & 0xff_ffff)
    }
}

// ------------------------------------------------------------------ globals

struct Callbacks {
    cancel: Box<dyn Fn() + Send>,
    confirm: Box<dyn Fn() + Send>,
}

static CALLBACKS: OnceLock<Mutex<Callbacks>> = OnceLock::new();
static RETRY_HANDLER: OnceLock<Mutex<Box<dyn Fn() + Send>>> = OnceLock::new();

/// Called when the user clicks an error pill that offers a retry.
pub fn set_retry_handler(on_retry: impl Fn() + Send + 'static) {
    let _ = RETRY_HANDLER.set(Mutex::new(Box::new(on_retry)));
}

fn offers_retry() -> bool {
    matches!(current_state(), PillState::Error { retry: true, .. })
}
static WINDOW: AtomicIsize = AtomicIsize::new(0);
static ALWAYS_VISIBLE: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);
/// Animation frame counter, advanced by the 16 ms timer.
static FRAME: AtomicU64 = AtomicU64::new(0);
/// User size in percent. Every dimension is multiplied by this on top of the
/// monitor DPI scale, so the pill can be made smaller than the default look.
static USER_SCALE: AtomicU32 = AtomicU32::new(DEFAULT_SCALE_PERCENT);

// Cheap render statistics, reported once per second at debug level.
static STAT_RENDERS: AtomicU64 = AtomicU64::new(0);
static STAT_NANOS: AtomicU64 = AtomicU64::new(0);
static STAT_NANOS_MAX: AtomicU64 = AtomicU64::new(0);
static STAT_UPDATES: AtomicU64 = AtomicU64::new(0);

fn stat_window() -> &'static Mutex<Option<std::time::Instant>> {
    static WINDOW_START: OnceLock<Mutex<Option<std::time::Instant>>> = OnceLock::new();
    WINDOW_START.get_or_init(|| Mutex::new(None))
}

fn record_render(nanos: u64) {
    STAT_RENDERS.fetch_add(1, Ordering::Relaxed);
    STAT_NANOS.fetch_add(nanos, Ordering::Relaxed);
    STAT_NANOS_MAX.fetch_max(nanos, Ordering::Relaxed);

    let Ok(mut guard) = stat_window().lock() else {
        return;
    };
    let now = std::time::Instant::now();
    match *guard {
        None => *guard = Some(now),
        Some(start) if now.duration_since(start).as_millis() >= 1000 => {
            *guard = Some(now);
            let renders = STAT_RENDERS.swap(0, Ordering::Relaxed).max(1);
            let total = STAT_NANOS.swap(0, Ordering::Relaxed);
            let peak = STAT_NANOS_MAX.swap(0, Ordering::Relaxed);
            let updates = STAT_UPDATES.swap(0, Ordering::Relaxed);
            log::debug!(
                "pill: {renders} renders/s, avg {:.2} ms, max {:.2} ms, {updates} state messages/s",
                total as f64 / renders as f64 / 1_000_000.0,
                peak as f64 / 1_000_000.0
            );
        }
        Some(_) => {}
    }
}

fn state_cell() -> &'static Mutex<PillState> {
    static STATE: OnceLock<Mutex<PillState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(PillState::Hidden))
}

fn current_state() -> PillState {
    state_cell()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or(PillState::Hidden)
}

/// Hit areas of the two circles in client coordinates.
#[derive(Debug, Clone, Copy, Default)]
struct HitAreas {
    cancel: (f32, f32, f32),
    confirm: (f32, f32, f32),
    active: bool,
}

fn hit_areas() -> &'static Mutex<HitAreas> {
    static AREAS: OnceLock<Mutex<HitAreas>> = OnceLock::new();
    AREAS.get_or_init(|| Mutex::new(HitAreas::default()))
}

pub fn set_scale(percent: u32) {
    let clamped = percent.clamp(MIN_SCALE_PERCENT, MAX_SCALE_PERCENT);
    let previous = USER_SCALE.swap(clamped, Ordering::SeqCst);
    if previous != clamped {
        repaint();
    }
}

fn user_scale() -> f32 {
    USER_SCALE.load(Ordering::SeqCst) as f32 / 100.0
}

pub fn set_always_visible(always: bool) {
    ALWAYS_VISIBLE.store(always, Ordering::SeqCst);
    if matches!(current_state(), PillState::Hidden | PillState::Idle) {
        set_state(if always {
            PillState::Idle
        } else {
            PillState::Hidden
        });
    }
}

// ------------------------------------------------------------------ canvas

/// A premultiplied BGRA pixel buffer with anti-aliased shape drawing.
struct Canvas<'a> {
    width: i32,
    height: i32,
    pixels: &'a mut [u8],
}

/// Signed distance to a rounded rectangle, negative inside.
#[inline]
fn rounded_rect_distance(
    px: f32,
    py: f32,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    radius: f32,
) -> f32 {
    let center_x = x + width / 2.0;
    let center_y = y + height / 2.0;
    let half_width = width / 2.0;
    let half_height = height / 2.0;
    let radius = radius.min(half_width).min(half_height).max(0.0);
    let qx = (px - center_x).abs() - (half_width - radius);
    let qy = (py - center_y).abs() - (half_height - radius);
    let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
    outside + qx.max(qy).min(0.0) - radius
}

impl<'a> Canvas<'a> {
    fn wrap(width: i32, height: i32, pixels: &'a mut [u8]) -> Canvas<'a> {
        Canvas {
            width: width.max(1),
            height: height.max(1),
            pixels,
        }
    }

    #[inline]
    fn blend(&mut self, x: i32, y: i32, color: [f32; 3], alpha: f32) {
        if alpha <= 0.0 || x < 0 || y < 0 || x >= self.width || y >= self.height {
            return;
        }
        let alpha = alpha.min(1.0);
        let index = ((y * self.width + x) * 4) as usize;
        let inverse = 1.0 - alpha;
        for (offset, channel) in [(0usize, 2usize), (1, 1), (2, 0)] {
            let destination = self.pixels[index + offset] as f32 / 255.0;
            let value = color[channel] * alpha + destination * inverse;
            self.pixels[index + offset] = (value * 255.0 + 0.5) as u8;
        }
        let destination_alpha = self.pixels[index + 3] as f32 / 255.0;
        let out_alpha = alpha + destination_alpha * inverse;
        self.pixels[index + 3] = (out_alpha * 255.0 + 0.5) as u8;
    }

    /// Fills where `sdf` is negative; `shade` returns color and alpha per pixel.
    fn fill_shaded<F, S>(&mut self, bounds: (f32, f32, f32, f32), sdf: F, shade: S)
    where
        F: Fn(f32, f32) -> f32,
        S: Fn(f32, f32) -> ([f32; 3], f32),
    {
        let x0 = (bounds.0.floor() as i32 - 1).max(0);
        let y0 = (bounds.1.floor() as i32 - 1).max(0);
        let x1 = (bounds.2.ceil() as i32 + 1).min(self.width - 1);
        let y1 = (bounds.3.ceil() as i32 + 1).min(self.height - 1);
        for y in y0..=y1 {
            for x in x0..=x1 {
                let px = x as f32 + 0.5;
                let py = y as f32 + 0.5;
                let coverage = (0.5 - sdf(px, py)).clamp(0.0, 1.0);
                if coverage > 0.0 {
                    let (color, alpha) = shade(px, py);
                    self.blend(x, y, color, coverage * alpha);
                }
            }
        }
    }

    fn fill_sdf<F>(&mut self, bounds: (f32, f32, f32, f32), color: [f32; 3], alpha: f32, sdf: F)
    where
        F: Fn(f32, f32) -> f32,
    {
        self.fill_shaded(bounds, sdf, move |_, _| (color, alpha));
    }

    /// The translucent glass body with a vertical gloss gradient.
    fn glass_body(
        &mut self,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        radius: f32,
        top: [f32; 3],
        bottom: [f32; 3],
        alpha: f32,
    ) {
        self.fill_shaded(
            (x, y, x + width, y + height),
            move |px, py| rounded_rect_distance(px, py, x, y, width, height, radius),
            move |_, py| {
                let t = ((py - y) / height).clamp(0.0, 1.0);
                let color = [
                    top[0] + (bottom[0] - top[0]) * t,
                    top[1] + (bottom[1] - top[1]) * t,
                    top[2] + (bottom[2] - top[2]) * t,
                ];
                (color, alpha)
            },
        );
    }

    /// The rim highlight: light catching the glass edge, bright at the top left.
    fn glass_rim(&mut self, x: f32, y: f32, width: f32, height: f32, radius: f32, thickness: f32) {
        let half = thickness / 2.0;
        self.fill_shaded(
            (
                x - thickness,
                y - thickness,
                x + width + thickness,
                y + height + thickness,
            ),
            move |px, py| rounded_rect_distance(px, py, x, y, width, height, radius).abs() - half,
            move |px, py| {
                let t = (((px - x) / width + (py - y) / height) / 2.0).clamp(0.0, 1.0);
                // Ease so the top edge keeps its highlight a little longer.
                let eased = t * t;
                (
                    WHITE,
                    RIM_ALPHA_NEAR + (RIM_ALPHA_FAR - RIM_ALPHA_NEAR) * eased,
                )
            },
        );
    }

    /// The soft outer shadow. Mathematically the same as stacking `steps`
    /// grown rounded rectangles at `layer_alpha`, but it walks the pixels once
    /// and evaluates the distance field once per pixel instead of `steps` times.
    fn soft_shadow(
        &mut self,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        radius: f32,
        blur: f32,
        steps: u32,
        layer_alpha: f32,
    ) {
        let x0 = ((x - blur).floor() as i32 - 1).max(0);
        let y0 = ((y - blur).floor() as i32 - 1).max(0);
        let x1 = ((x + width + blur).ceil() as i32 + 1).min(self.width - 1);
        let y1 = ((y + height + blur).ceil() as i32 + 1).min(self.height - 1);
        for py in y0..=y1 {
            for px in x0..=x1 {
                let distance = rounded_rect_distance(
                    px as f32 + 0.5,
                    py as f32 + 0.5,
                    x,
                    y,
                    width,
                    height,
                    radius,
                );
                if distance > blur + 1.0 {
                    continue;
                }
                let mut remaining = 1.0f32;
                for step in 1..=steps {
                    let grow = blur * step as f32 / steps as f32;
                    let coverage = (0.5 - (distance - grow)).clamp(0.0, 1.0);
                    if coverage > 0.0 {
                        remaining *= 1.0 - layer_alpha * coverage;
                    }
                }
                self.blend(px, py, [0.0, 0.0, 0.0], 1.0 - remaining);
            }
        }
    }

    fn circle(&mut self, cx: f32, cy: f32, radius: f32, color: [f32; 3], alpha: f32) {
        self.fill_sdf(
            (cx - radius, cy - radius, cx + radius, cy + radius),
            color,
            alpha,
            move |px, py| ((px - cx).powi(2) + (py - cy).powi(2)).sqrt() - radius,
        );
    }

    fn line(
        &mut self,
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
        thickness: f32,
        color: [f32; 3],
        alpha: f32,
    ) {
        let half = thickness / 2.0;
        let bounds = (
            x0.min(x1) - half,
            y0.min(y1) - half,
            x0.max(x1) + half,
            y0.max(y1) + half,
        );
        self.fill_sdf(bounds, color, alpha, move |px, py| {
            let vx = x1 - x0;
            let vy = y1 - y0;
            let length_squared = vx * vx + vy * vy;
            let t = if length_squared <= 0.0 {
                0.0
            } else {
                (((px - x0) * vx + (py - y0) * vy) / length_squared).clamp(0.0, 1.0)
            };
            let dx = px - (x0 + vx * t);
            let dy = py - (y0 + vy * t);
            (dx * dx + dy * dy).sqrt() - half
        });
    }
}

// ------------------------------------------------------------------ layout

struct Layout {
    window_width: i32,
    window_height: i32,
    /// The one continuous glass shape, in client coordinates.
    shape_x: f32,
    shape_y: f32,
    shape_width: f32,
    shape_height: f32,
    radius: f32,
    /// Top of the button row inside the shape.
    row_top: f32,
    row_height: f32,
    /// Text area inside the shape (already padded), if there is a transcript.
    text_area: Option<(f32, f32, f32, f32)>,
    scale: f32,
}

/// Size of the one continuous shape for a state: width, height, corner radius
/// and the height of the button row at its bottom. `text_height` is the
/// measured transcript height (0 when there is none).
fn shape_metrics(
    state: &PillState,
    scale: f32,
    text_width: f32,
    text_height: f32,
) -> (f32, f32, f32, f32) {
    let has_text = text_height > 0.0;
    match state {
        PillState::Idle => (
            IDLE_WIDTH * scale,
            IDLE_HEIGHT * scale,
            IDLE_HEIGHT * scale / 2.0,
            IDLE_HEIGHT * scale,
        ),
        PillState::Error { .. } => {
            let width = (text_width + 2.0 * TEXT_PADDING * scale)
                .clamp(PILL_WIDTH * scale, PANEL_MAX_WIDTH * scale);
            (
                width,
                PILL_HEIGHT * scale,
                PILL_HEIGHT * scale / 2.0,
                PILL_HEIGHT * scale,
            )
        }
        _ if has_text => {
            let width = (text_width + 2.0 * TEXT_PADDING * scale)
                .clamp(PILL_WIDTH * scale, PANEL_MAX_WIDTH * scale);
            let height = text_height + 2.0 * TEXT_PADDING * scale + PILL_HEIGHT * scale;
            (width, height, PANEL_RADIUS * scale, PILL_HEIGHT * scale)
        }
        _ => (
            PILL_WIDTH * scale,
            PILL_HEIGHT * scale,
            PILL_HEIGHT * scale / 2.0,
            PILL_HEIGHT * scale,
        ),
    }
}

/// Places a shape of the given size inside a window. The shape always sits at
/// the bottom center, so a scaled or interpolated shape grows out of the
/// resting position instead of jumping.
fn layout_with(
    shape_width: f32,
    shape_height: f32,
    radius: f32,
    row_height: f32,
    window_width: i32,
    window_height: i32,
    scale: f32,
) -> Layout {
    let margin = SHADOW_MARGIN * scale;
    let shape_x = ((window_width as f32) - shape_width) / 2.0;
    let shape_y = (window_height as f32) - margin - shape_height;

    let padding = TEXT_PADDING * scale;
    let text_height = shape_height - row_height - 2.0 * padding;
    let text_area = if text_height > 1.0 {
        Some((
            shape_x + padding,
            shape_y + padding,
            shape_width - 2.0 * padding,
            text_height,
        ))
    } else {
        None
    };

    Layout {
        window_width,
        window_height,
        shape_x,
        shape_y,
        shape_width,
        shape_height,
        radius,
        row_top: shape_y + shape_height - row_height,
        row_height,
        text_area,
        scale,
    }
}

/// Window size for a shape at rest (the shadow lives outside the shape).
fn window_size_for(shape_width: f32, shape_height: f32, scale: f32) -> (i32, i32) {
    let margin = SHADOW_MARGIN * scale;
    (
        (shape_width + 2.0 * margin).ceil() as i32,
        (shape_height + 2.0 * margin).ceil() as i32,
    )
}

// ------------------------------------------------------------- transitions

/// Show: scale up from 0.6 with a small overshoot, fade in.
const SHOW_MS: f32 = 180.0;
/// Hide: shrink back and fade out, then the window disappears.
const HIDE_MS: f32 = 140.0;
/// Collapsed pill to grown transcript window and back.
const RESIZE_MS: f32 = 200.0;
const SHOW_FROM: f32 = 0.6;
/// Peak of the overshoot, used to size the window so nothing is clipped.
const SHOW_PEAK: f32 = 1.04;

fn ease_out_back(t: f32) -> f32 {
    // c1 around 0.5 gives roughly a 3 percent overshoot.
    let c1 = 0.5f32;
    let c3 = c1 + 1.0;
    let u = t - 1.0;
    1.0 + c3 * u * u * u + c1 * u * u
}

fn ease_out_cubic(t: f32) -> f32 {
    let u = 1.0 - t;
    1.0 - u * u * u
}

fn ease_in_quad(t: f32) -> f32 {
    t * t
}

fn show_scale(t: f32) -> f32 {
    SHOW_FROM + (1.0 - SHOW_FROM) * ease_out_back(t)
}

fn show_alpha(t: f32) -> f32 {
    ease_out_cubic((t / 0.6).min(1.0))
}

fn hide_scale(t: f32) -> f32 {
    1.0 - (1.0 - SHOW_FROM) * ease_in_quad(t)
}

fn hide_alpha(t: f32) -> f32 {
    1.0 - ease_in_quad(t)
}

/// Finds the progress at which a curve reaches `target`, so a reversed
/// transition starts exactly where the running one stood.
fn invert(curve: fn(f32) -> f32, target: f32) -> f32 {
    let mut low = 0.0f32;
    let mut high = 1.0f32;
    for _ in 0..16 {
        let mid = (low + high) / 2.0;
        if (curve(mid) - curve(0.0)).abs() < (target - curve(0.0)).abs() {
            low = mid;
        } else {
            high = mid;
        }
    }
    (low + high) / 2.0
}

// ------------------------------------------------------------------ drawing

/// Which kind of state this is, ignoring level and text. Only a change here
/// needs a window message; level updates ride along with the animation timer.
fn kind_of(state: &PillState) -> u8 {
    match state {
        PillState::Hidden => 0,
        PillState::Idle => 1,
        PillState::Recording { .. } => 2,
        PillState::Processing => 3,
        PillState::Error { .. } => 4,
        PillState::Done => 5,
    }
}

/// True while the 16 ms timer is running for this kind.
fn kind_animates(kind: u8) -> bool {
    matches!(kind, 2 | 3 | 5)
}

/// Everything that does not change from frame to frame: shadow, glass body,
/// rim and (for the collapsed idle look) the dim dots. Cached per size.
fn draw_static(canvas: &mut Canvas, state: &PillState, layout: &Layout) {
    let scale = layout.scale;
    let error = matches!(state, PillState::Error { .. });

    let x = layout.shape_x;
    let y = layout.shape_y;
    let width = layout.shape_width;
    let height = layout.shape_height;
    let radius = layout.radius;

    // Soft outer shadow, offset down.
    canvas.soft_shadow(
        x,
        y + SHADOW_OFFSET_Y * scale,
        width,
        height,
        radius,
        10.0 * scale,
        10,
        0.042,
    );

    let (top, bottom) = if error {
        (GLASS_ERROR_TOP, GLASS_ERROR_BOTTOM)
    } else {
        (GLASS_TOP, GLASS_BOTTOM)
    };
    canvas.glass_body(x, y, width, height, radius, top, bottom, GLASS_ALPHA);
    canvas.glass_rim(
        x + RIM_THICKNESS * scale / 2.0,
        y + RIM_THICKNESS * scale / 2.0,
        width - RIM_THICKNESS * scale,
        height - RIM_THICKNESS * scale,
        radius - RIM_THICKNESS * scale / 2.0,
        RIM_THICKNESS * scale,
    );

    if matches!(state, PillState::Idle) {
        // Collapsed look: a row of dim dots, no buttons.
        let middle = layout.row_top + layout.row_height / 2.0;
        let spacing = (width - 24.0 * scale) / 9.0;
        let left = x + 12.0 * scale;
        for index in 0..10 {
            canvas.circle(
                left + spacing * index as f32,
                middle,
                DOT_RADIUS * scale,
                WHITE,
                0.35,
            );
        }
    }
}

/// The moving parts: the two buttons and the ten dots. Drawn on a copy of the
/// cached static layer, so this is the only work done per frame.
fn draw_dynamic(canvas: &mut Canvas, state: &PillState, layout: &Layout, frame: u64) {
    let scale = layout.scale;
    let time = frame as f32 * 0.016;

    if matches!(
        state,
        PillState::Idle | PillState::Error { .. } | PillState::Hidden
    ) {
        if let Ok(mut areas) = hit_areas().lock() {
            *areas = HitAreas::default();
        }
        return;
    }

    let x = layout.shape_x;
    let width = layout.shape_width;
    let middle = layout.row_top + layout.row_height / 2.0;

    // Left: cancel circle with a thin X.
    let button_radius = BUTTON_RADIUS * scale;
    let cancel_x = x + SIDE_PADDING * scale + button_radius;
    canvas.circle(cancel_x, middle, button_radius, CANCEL_CIRCLE, 1.0);
    let arm = 5.0 * scale;
    let stroke = 2.0 * scale;
    canvas.line(
        cancel_x - arm,
        middle - arm,
        cancel_x + arm,
        middle + arm,
        stroke,
        WHITE,
        0.95,
    );
    canvas.line(
        cancel_x - arm,
        middle + arm,
        cancel_x + arm,
        middle - arm,
        stroke,
        WHITE,
        0.95,
    );

    // Right: confirm circle with a thin check. In Done it flashes.
    let confirm_x = x + width - SIDE_PADDING * scale - button_radius;
    let done = matches!(state, PillState::Done);
    let flash = if done {
        0.78 + 0.22 * (time * 14.0).sin()
    } else {
        1.0
    };
    let confirm_radius = if done {
        button_radius * (1.0 + 0.05 * (time * 14.0).sin().max(0.0))
    } else {
        button_radius
    };
    canvas.circle(confirm_x, middle, confirm_radius, WHITE, flash);
    let check = 1.9 * scale;
    canvas.line(
        confirm_x - 4.6 * scale,
        middle + 0.3 * scale,
        confirm_x - 1.4 * scale,
        middle + 3.6 * scale,
        check,
        BLACK,
        1.0,
    );
    canvas.line(
        confirm_x - 1.4 * scale,
        middle + 3.6 * scale,
        confirm_x + 4.8 * scale,
        middle - 3.6 * scale,
        check,
        BLACK,
        1.0,
    );

    if let Ok(mut areas) = hit_areas().lock() {
        *areas = HitAreas {
            cancel: (cancel_x, middle, button_radius + 2.0 * scale),
            confirm: (confirm_x, middle, button_radius + 2.0 * scale),
            active: true,
        };
    }

    // Ten tiny dots, centered between the two buttons.
    let spacing = DOT_SPACING * scale;
    let center = (cancel_x + button_radius + confirm_x - button_radius) / 2.0;
    let left = center - spacing * 4.5;
    let dot_color = if matches!(state, PillState::Recording { .. }) {
        recording_dot_color()
    } else {
        WHITE
    };

    for index in 0..10 {
        let dot_x = left + spacing * index as f32;
        let (dot_radius, alpha) = match state {
            PillState::Recording { level, .. } => {
                let wave = 0.55 + 0.45 * (time * 7.0 + index as f32 * 0.85).sin();
                let amount = level.clamp(0.0, 1.0) * wave;
                (
                    (DOT_RADIUS + (DOT_RADIUS_MAX - DOT_RADIUS) * amount) * scale,
                    0.6 + 0.4 * amount,
                )
            }
            PillState::Processing => {
                let phase = (time * 5.0 - index as f32 * 0.55).sin().max(0.0);
                (
                    (DOT_RADIUS + (DOT_RADIUS_MAX - DOT_RADIUS) * 0.8 * phase) * scale,
                    0.4 + 0.6 * phase,
                )
            }
            _ => (DOT_RADIUS * scale, 0.5),
        };
        canvas.circle(dot_x, middle, dot_radius, dot_color, alpha);
    }
}

// ------------------------------------------------------------ shared tests

#[cfg(test)]
mod skin_tests {
    use super::*;

    fn hex(color: [f32; 3]) -> u32 {
        let c = |v: f32| (v * 255.0).round() as u32;
        (c(color[0]) << 16) | (c(color[1]) << 8) | c(color[2])
    }

    #[test]
    fn pill_skin_colors_map_to_shop_items() {
        assert_eq!(skin_accent(Some("pill-amber")).map(hex), Some(0xe8b44a));
        assert_eq!(skin_accent(Some("pill-mint")).map(hex), Some(0x4fd8a4));
        assert_eq!(skin_accent(Some("pill-coral")).map(hex), Some(0xf0736f));
        assert_eq!(skin_accent(None), None);
        assert_eq!(skin_accent(Some("tower-gold")), None);
        // Every pill item in the shop has a color, and every color is a shop item.
        let shop_pills: Vec<&str> = crate::economy::SHOP
            .iter()
            .filter(|item| item.kind.as_str() == "pill")
            .map(|item| item.id)
            .collect();
        let skins: Vec<&str> = PILL_SKINS.iter().map(|(id, _)| *id).collect();
        assert_eq!(shop_pills, skins);
    }

    #[test]
    fn set_skin_switches_recording_dots_and_back() {
        set_skin(Some("pill-coral"));
        assert_eq!(hex(recording_dot_color()), 0xf0736f);
        set_skin(Some("not-a-skin"));
        assert_eq!(recording_dot_color(), WHITE);
        set_skin(Some("pill-mint"));
        assert_eq!(hex(recording_dot_color()), 0x4fd8a4);
        set_skin(None);
        assert_eq!(recording_dot_color(), WHITE);
    }

    /// Minimal PNG writer (stored deflate blocks), enough for test previews.
    fn write_png(path: &std::path::Path, width: u32, height: u32, rgba: &[u8]) {
        fn crc32(data: &[u8]) -> u32 {
            let mut crc = 0xffff_ffffu32;
            for &byte in data {
                crc ^= byte as u32;
                for _ in 0..8 {
                    crc = if crc & 1 != 0 { 0xedb8_8320 ^ (crc >> 1) } else { crc >> 1 };
                }
            }
            !crc
        }
        fn chunk(out: &mut Vec<u8>, kind: &[u8], data: &[u8]) {
            out.extend_from_slice(&(data.len() as u32).to_be_bytes());
            let mut body = kind.to_vec();
            body.extend_from_slice(data);
            out.extend_from_slice(&body);
            out.extend_from_slice(&crc32(&body).to_be_bytes());
        }
        let mut raw = Vec::new();
        for row in rgba.chunks((width * 4) as usize) {
            raw.push(0);
            raw.extend_from_slice(row);
        }
        let mut zlib = vec![0x78, 0x01];
        let blocks: Vec<&[u8]> = raw.chunks(65_535).collect();
        for (i, block) in blocks.iter().enumerate() {
            zlib.push(if i + 1 == blocks.len() { 1 } else { 0 });
            let len = block.len() as u16;
            zlib.extend_from_slice(&len.to_le_bytes());
            zlib.extend_from_slice(&(!len).to_le_bytes());
            zlib.extend_from_slice(block);
        }
        let (mut a, mut b) = (1u32, 0u32);
        for &byte in &raw {
            a = (a + byte as u32) % 65_521;
            b = (b + a) % 65_521;
        }
        zlib.extend_from_slice(&((b << 16) | a).to_be_bytes());
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&width.to_be_bytes());
        ihdr.extend_from_slice(&height.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        chunk(&mut png, b"IHDR", &ihdr);
        chunk(&mut png, b"IDAT", &zlib);
        chunk(&mut png, b"IEND", &[]);
        std::fs::write(path, png).unwrap();
    }

    /// Renders the recording pill with the shared rasterizer (no window, no
    /// microphone) for the default look and every skin, on a light desktop
    /// gray, at 1x and 3x. Output: SPECHY_PILL_SHOTS or %TEMP%\spechy-pillskins.
    #[test]
    #[ignore = "Writes PNG previews of the pill skins"]
    fn pill_skin_previews() {
        let directory = std::env::var("SPECHY_PILL_SHOTS")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("spechy-pillskins"));
        std::fs::create_dir_all(&directory).unwrap();
        let state = PillState::Recording { level: 0.75, live_text: String::new() };
        let mut skins: Vec<Option<&str>> = vec![None];
        skins.extend(PILL_SKINS.iter().map(|(id, _)| Some(*id)));
        for skin in skins {
            set_skin(skin);
            for scale in [1.0f32, 3.0] {
                let (sw, sh, radius, row) = shape_metrics(&state, scale, 0.0, 0.0);
                let (width, height) = window_size_for(sw, sh, scale);
                let layout = layout_with(sw, sh, radius, row, width, height, scale);
                let mut pixels = vec![0u8; (width * height * 4) as usize];
                for px in pixels.chunks_mut(4) {
                    px.copy_from_slice(&[0xd8, 0xd8, 0xd8, 0xff]);
                }
                let mut canvas = Canvas::wrap(width, height, &mut pixels);
                draw_static(&mut canvas, &state, &layout);
                draw_dynamic(&mut canvas, &state, &layout, 20);
                let rgba: Vec<u8> = pixels
                    .chunks(4)
                    .flat_map(|p| [p[2], p[1], p[0], p[3]])
                    .collect();
                let name = format!("{}_{}x.png", skin.unwrap_or("default"), scale as u32);
                let path = directory.join(name);
                write_png(&path, width as u32, height as u32, &rgba);
                println!("{}", path.display());
            }
        }
        set_skin(None);
    }
}

// ------------------------------------------------------------------ Win32

#[cfg(windows)]
mod win {
    use super::*;
    use windows::core::w;
    use windows::Win32::Foundation::{
        COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM,
    };
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteObject, DrawTextW, GdiFlush,
        IntersectClipRect, SelectClipRgn, SelectObject, SetBkMode, SetTextColor, UpdateWindow,
        AC_SRC_ALPHA, AC_SRC_OVER, ANTIALIASED_QUALITY, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        BLENDFUNCTION, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DIB_RGB_COLORS, DT_CALCRECT,
        DT_CENTER, DT_END_ELLIPSIS, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, DT_WORDBREAK,
        FF_DONTCARE, FW_NORMAL, HBITMAP, HDC, HGDIOBJ, OUT_TT_PRECIS, TRANSPARENT,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::WindowsAndMessaging::*;

    const WM_PILL_UPDATE: u32 = WM_APP + 11;
    /// 16 ms animation timer.
    const TIMER_ANIMATION: usize = 1;
    /// One-shot timer that hides the pill after a Done, independent of the
    /// animation timer so a busy message queue cannot keep the pill on screen.
    const TIMER_HIDE: usize = 2;
    const DONE_VISIBLE_MS: u32 = 600;
    /// Independent of animation: idle and retry pills must stay above other apps too.
    const TIMER_Z_ORDER: usize = 3;
    const Z_ORDER_INTERVAL_MS: u32 = 250;

    /// Text is drawn into a premultiplied buffer, so its color has to be
    /// multiplied by the glass alpha and the text alpha up front.
    const TEXT_ALPHA: f32 = 0.92;

    pub fn start(
        cancel: Box<dyn Fn() + Send>,
        confirm: Box<dyn Fn() + Send>,
    ) -> Result<(), String> {
        let _ = CALLBACKS.set(Mutex::new(Callbacks { cancel, confirm }));

        let (sender, receiver) = std::sync::mpsc::channel::<Result<(), String>>();
        std::thread::spawn(move || unsafe {
            match create_window() {
                Ok(hwnd) => {
                    WINDOW.store(hwnd.0 as isize, Ordering::SeqCst);
                    let _ = sender.send(Ok(()));
                    let mut message = MSG::default();
                    while GetMessageW(&mut message, None, 0, 0).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error));
                }
            }
        });

        receiver
            .recv()
            .unwrap_or_else(|error| Err(format!("Pill thread did not start: {error}")))
    }

    unsafe fn create_window() -> Result<HWND, String> {
        let instance = GetModuleHandleW(None).map_err(|e| e.to_string())?;
        let class_name = w!("SpechyPillWindow");

        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(window_proc),
            hInstance: HINSTANCE(instance.0),
            lpszClassName: class_name,
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            ..Default::default()
        };
        // A second registration is harmless: the class already exists.
        RegisterClassExW(&class);

        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_LAYERED,
            class_name,
            w!("Spechy"),
            WS_POPUP,
            0,
            0,
            300,
            80,
            None,
            None,
            HINSTANCE(instance.0),
            None,
        )
        .map_err(|e| format!("Could not create the pill window: {e}"))
    }

    pub fn notify() {
        let handle = WINDOW.load(Ordering::SeqCst);
        if handle != 0 {
            unsafe {
                let _ = PostMessageW(
                    HWND(handle as *mut core::ffi::c_void),
                    WM_PILL_UPDATE,
                    WPARAM(0),
                    LPARAM(0),
                );
            }
        }
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_PILL_UPDATE => {
                STAT_UPDATES.fetch_add(1, Ordering::Relaxed);
                apply_state(hwnd);
                LRESULT(0)
            }
            WM_TIMER => {
                if wparam.0 == TIMER_Z_ORDER {
                    ensure_topmost(hwnd);
                    return LRESULT(0);
                }
                if wparam.0 == TIMER_HIDE {
                    let _ = KillTimer(hwnd, TIMER_HIDE);
                    if matches!(current_state(), PillState::Done) {
                        let next = if ALWAYS_VISIBLE.load(Ordering::SeqCst) {
                            PillState::Idle
                        } else {
                            PillState::Hidden
                        };
                        if let Ok(mut guard) = state_cell().lock() {
                            *guard = next;
                        }
                        apply_state(hwnd);
                    }
                    return LRESULT(0);
                }
                FRAME.fetch_add(1, Ordering::Relaxed);
                render(hwnd);
                finish_transition(hwnd);
                sync_timer(hwnd);
                LRESULT(0)
            }
            WM_NCHITTEST => LRESULT(HTCLIENT as isize),
            WM_SETCURSOR if offers_retry() => {
                if let Ok(hand) = LoadCursorW(None, IDC_HAND) {
                    SetCursor(hand);
                }
                LRESULT(1)
            }
            WM_LBUTTONDOWN if offers_retry() => {
                // Run outside the window procedure: the handler touches pipeline
                // state and calls back into set_state.
                std::thread::spawn(|| {
                    if let Some(cell) = RETRY_HANDLER.get() {
                        if let Ok(handler) = cell.lock() {
                            (handler)();
                        }
                    }
                });
                LRESULT(0)
            }
            WM_LBUTTONDOWN => {
                let x = (lparam.0 & 0xFFFF) as i16 as f32;
                let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as f32;
                let areas = hit_areas().lock().map(|guard| *guard).unwrap_or_default();
                if areas.active {
                    let inside = |area: (f32, f32, f32)| {
                        ((x - area.0).powi(2) + (y - area.1).powi(2)).sqrt() <= area.2
                    };
                    if inside(areas.cancel) {
                        if let Some(cell) = CALLBACKS.get() {
                            if let Ok(callbacks) = cell.lock() {
                                (callbacks.cancel)();
                            }
                        }
                    } else if inside(areas.confirm) {
                        if let Some(cell) = CALLBACKS.get() {
                            if let Ok(callbacks) = cell.lock() {
                                (callbacks.confirm)();
                            }
                        }
                    }
                }
                LRESULT(0)
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }

    /// Reassert Z-order without ever activating the dictation UI. TOPMOST at
    /// creation alone does not keep us above windows promoted there later.
    unsafe fn raise_without_focus(hwnd: HWND) {
        if let Err(error) = SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        ) {
            log::warn!("Could not restore pill Z-order: {error}");
        }
    }

    unsafe fn ensure_topmost(hwnd: HWND) {
        // A queued timer must never bring a hidden pill back.
        if !IsWindowVisible(hwnd).as_bool() {
            return;
        }
        if GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0 == 0 {
            raise_without_focus(hwnd);
            return;
        }
        let mut pill_rect = RECT::default();
        if GetWindowRect(hwnd, &mut pill_rect).is_err() {
            return;
        }
        // Only repair actual overlap, not every animation frame or unrelated
        // topmost window elsewhere on the desktop. Bound traversal if Z-order
        // changes under us while other apps are opening/closing windows.
        let mut previous = GetWindow(hwnd, GW_HWNDPREV);
        for _ in 0..256 {
            let Ok(other) = previous else { break };
            if other.0.is_null() {
                break;
            }
            let mut rect = RECT::default();
            if IsWindowVisible(other).as_bool()
                && GetWindowRect(other, &mut rect).is_ok()
                && rect.left < pill_rect.right
                && rect.right > pill_rect.left
                && rect.top < pill_rect.bottom
                && rect.bottom > pill_rect.top
            {
                raise_without_focus(hwnd);
                break;
            }
            previous = GetWindow(other, GW_HWNDPREV);
        }
    }

    unsafe fn hide_window(hwnd: HWND) {
        let _ = KillTimer(hwnd, TIMER_Z_ORDER);
        let _ = ShowWindow(hwnd, SW_HIDE);
    }

    unsafe fn apply_state(hwnd: HWND) {
        let state = current_state();

        // Arm the hide timer exactly once per Done, drop it in every other state.
        if matches!(state, PillState::Done) {
            SetTimer(hwnd, TIMER_HIDE, DONE_VISIBLE_MS, None);
        } else {
            let _ = KillTimer(hwnd, TIMER_HIDE);
        }

        // A late Done, after the pill is gone or already on its way out, is the
        // tail of a finished dictation: it must not pop the pill back up.
        if matches!(state, PillState::Done) {
            let stale = ANIM.with(|cell| {
                let anim = cell.borrow();
                !anim.visible || anim.motion == Motion::Hide
            });
            if stale {
                let _ = KillTimer(hwnd, TIMER_HIDE);
                if let Ok(mut guard) = state_cell().lock() {
                    if matches!(*guard, PillState::Done) {
                        *guard = PillState::Hidden;
                    }
                }
                return;
            }
        }

        let state = current_state();
        let hiding = ANIM.with(|cell| {
            let mut anim = cell.borrow_mut();
            if matches!(state, PillState::Hidden) {
                if !anim.visible {
                    anim.motion = Motion::None;
                    return false;
                }
                if anim.motion != Motion::Hide {
                    // A hide during a show picks up where the show stood.
                    let done = if anim.motion == Motion::Show {
                        invert(hide_scale, show_scale(anim.progress()))
                    } else {
                        0.0
                    };
                    anim.begin(Motion::Hide, done);
                }
                true
            } else {
                anim.visible_state = state.clone();
                if !anim.visible {
                    anim.visible = true;
                    anim.last_shape = None;
                    anim.begin(Motion::Show, 0.0);
                } else if anim.motion == Motion::Hide {
                    // A show during a hide reverses smoothly.
                    let done = invert(show_scale, hide_scale(anim.progress()));
                    anim.begin(Motion::Show, done);
                }
                false
            }
        });

        if matches!(state, PillState::Hidden) && !hiding {
            let _ = KillTimer(hwnd, TIMER_ANIMATION);
            hide_window(hwnd);
            return;
        }

        render(hwnd);
        let was_visible = IsWindowVisible(hwnd).as_bool();
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        raise_without_focus(hwnd);
        if !was_visible {
            SetTimer(hwnd, TIMER_Z_ORDER, Z_ORDER_INTERVAL_MS, None);
        }
        let _ = UpdateWindow(hwnd);
        sync_timer(hwnd);
    }

    /// The animation timer runs while a state animates or a transition is live.
    unsafe fn sync_timer(hwnd: HWND) {
        let wanted = kind_animates(kind_of(&current_state()))
            || ANIM.with(|cell| cell.borrow().motion != Motion::None);
        if wanted {
            // 10 ms rounds down to one system tick (about 15.6 ms); 16 ms would
            // round up to two ticks and halve the frame rate.
            SetTimer(hwnd, TIMER_ANIMATION, 10, None);
        } else {
            let _ = KillTimer(hwnd, TIMER_ANIMATION);
        }
    }

    /// Ends a finished transition; a finished hide takes the window off screen.
    unsafe fn finish_transition(hwnd: HWND) {
        let hide_now = ANIM.with(|cell| {
            let mut anim = cell.borrow_mut();
            if anim.motion == Motion::None || anim.progress() < 1.0 {
                return false;
            }
            let was_hide = anim.motion == Motion::Hide;
            anim.motion = Motion::None;
            if was_hide {
                anim.visible = false;
                anim.last_shape = None;
            }
            was_hide
        });
        if hide_now {
            hide_window(hwnd);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        struct TestWindow(HWND);
        impl Drop for TestWindow {
            fn drop(&mut self) {
                unsafe {
                    let _ = DestroyWindow(self.0);
                }
            }
        }

        unsafe fn pump_for(ms: u64) {
            let until = std::time::Instant::now() + std::time::Duration::from_millis(ms);
            while std::time::Instant::now() < until {
                let mut message = MSG::default();
                while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }

        unsafe fn above(first: HWND, second: HWND) -> bool {
            let mut cursor = GetWindow(second, GW_HWNDPREV);
            for _ in 0..256 {
                let Ok(hwnd) = cursor else { return false };
                if hwnd == first {
                    return true;
                }
                if hwnd.0.is_null() {
                    return false;
                }
                cursor = GetWindow(hwnd, GW_HWNDPREV);
            }
            false
        }

        #[test]
        #[ignore = "Creates small native windows; run on an interactive Windows desktop"]
        fn pill_recovers_z_order_without_stealing_focus() {
            unsafe {
                let pill = TestWindow(create_window().unwrap());
                let competitor = TestWindow(
                    CreateWindowExW(
                        WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                        w!("STATIC"),
                        w!("Spechy Z-order test"),
                        WS_POPUP,
                        0,
                        0,
                        195,
                        52,
                        None,
                        None,
                        HINSTANCE(GetModuleHandleW(None).unwrap().0),
                        None,
                    )
                    .unwrap(),
                );
                for state in [
                    PillState::Idle,
                    PillState::Recording {
                        level: 0.3,
                        live_text: "Z-order regression test".into(),
                    },
                    PillState::Processing,
                    PillState::Error {
                        message: "Click to retry".into(),
                        retry: true,
                    },
                ] {
                    *state_cell().lock().unwrap() = state;
                    apply_state(pill.0);
                    pump_for(400);
                    let mut before = RECT::default();
                    GetWindowRect(pill.0, &mut before).unwrap();
                    SetWindowPos(
                        competitor.0,
                        HWND_TOPMOST,
                        before.left,
                        before.top,
                        before.right - before.left,
                        before.bottom - before.top,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    )
                    .unwrap();
                    assert!(
                        above(competitor.0, pill.0),
                        "test must reproduce an occluded pill"
                    );
                    let focus = GetForegroundWindow();
                    pump_for(600);
                    assert!(
                        above(pill.0, competitor.0),
                        "visible pill must recover automatically"
                    );
                    assert_eq!(GetForegroundWindow(), focus, "repair must not steal focus");
                    let mut after = RECT::default();
                    GetWindowRect(pill.0, &mut after).unwrap();
                    assert_eq!(
                        (before.left, before.top, before.right, before.bottom),
                        (after.left, after.top, after.right, after.bottom)
                    );
                }
                // Also recover if an external tool removes the topmost style.
                SetWindowPos(
                    pill.0,
                    HWND_NOTOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                )
                .unwrap();
                assert_eq!(
                    GetWindowLongW(pill.0, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0,
                    0
                );
                pump_for(600);
                assert_ne!(
                    GetWindowLongW(pill.0, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0,
                    0
                );

                *state_cell().lock().unwrap() = PillState::Hidden;
                apply_state(pill.0);
                pump_for(600);
                assert!(!IsWindowVisible(pill.0).as_bool());
                assert!(
                    KillTimer(pill.0, TIMER_Z_ORDER).is_err(),
                    "hidden pill must stop its timer"
                );
                // Simulate an already queued tick after hiding.
                window_proc(pill.0, WM_TIMER, WPARAM(TIMER_Z_ORDER), LPARAM(0));
                assert!(!IsWindowVisible(pill.0).as_bool());
                *state_cell().lock().unwrap() = PillState::Idle;
                apply_state(pill.0);
                assert!(IsWindowVisible(pill.0).as_bool());
                assert!(
                    above(pill.0, competitor.0),
                    "re-show must raise immediately"
                );
                hide_window(pill.0);
                *state_cell().lock().unwrap() = PillState::Hidden;
            }
        }
    }

    /// Work area of the primary monitor in physical pixels.
    unsafe fn work_area() -> RECT {
        let mut rect = RECT::default();
        let ok = SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut rect as *mut RECT as *mut core::ffi::c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        if ok.is_err() || rect.right <= rect.left {
            rect = RECT {
                left: 0,
                top: 0,
                right: GetSystemMetrics(SM_CXSCREEN),
                bottom: GetSystemMetrics(SM_CYSCREEN),
            };
        }
        rect
    }

    unsafe fn make_font(scale: f32, size: f32) -> HGDIOBJ {
        HGDIOBJ(
            CreateFontW(
                -((size * scale).round() as i32),
                0,
                0,
                0,
                FW_NORMAL.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET.0 as u32,
                OUT_TT_PRECIS.0 as u32,
                CLIP_DEFAULT_PRECIS.0 as u32,
                ANTIALIASED_QUALITY.0 as u32,
                FF_DONTCARE.0 as u32,
                w!("Segoe UI"),
            )
            .0,
        )
    }

    /// Everything that is expensive to create lives here and is reused across
    /// frames: the memory DC, the DIB the layered window is updated from, the
    /// font, the measured text size and the cached static layer.
    struct Surface {
        dc: HDC,
        bitmap: HBITMAP,
        old_bitmap: HGDIOBJ,
        bits: *mut u8,
        width: i32,
        height: i32,
        byte_count: usize,
        font: HGDIOBJ,
        font_scale_bits: u32,
        /// Shadow, glass, rim and the baked text; everything but the moving parts.
        base: Vec<u8>,
        base_key: Option<CacheKey>,
        /// Alpha channel backup while GDI draws text on an uncached frame.
        alpha_scratch: Vec<u8>,
        measure_key: Option<(String, u32, bool)>,
        measure: (f32, f32),
    }

    #[derive(PartialEq, Clone)]
    struct CacheKey {
        width: i32,
        height: i32,
        kind: u8,
        scale_bits: u32,
        text: String,
    }

    thread_local! {
        static SURFACE: std::cell::RefCell<Option<Surface>> =
            const { std::cell::RefCell::new(None) };
        static ANIM: std::cell::RefCell<Anim> = std::cell::RefCell::new(Anim::new());
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Motion {
        None,
        Show,
        Hide,
        Resize,
    }

    /// Drives the appear, disappear and grow transitions. Lives on the pill
    /// thread only, like the surface.
    struct Anim {
        motion: Motion,
        start: std::time::Instant,
        /// Shape the resize starts from: width, height, radius.
        from_shape: (f32, f32, f32, f32),
        /// What to draw while hiding: by then the state cell already says Hidden.
        visible_state: PillState,
        /// True once the window is on screen, false again after a hide finished.
        visible: bool,
        /// Shape of the last frame drawn at rest, to notice a size change.
        last_shape: Option<(f32, f32, f32, f32)>,
        last_scale_bits: u32,
    }

    impl Anim {
        fn new() -> Anim {
            Anim {
                motion: Motion::None,
                start: std::time::Instant::now(),
                from_shape: (0.0, 0.0, 0.0, 0.0),
                visible_state: PillState::Hidden,
                visible: false,
                last_shape: None,
                last_scale_bits: 0,
            }
        }

        fn progress(&self) -> f32 {
            let span = match self.motion {
                Motion::Show => SHOW_MS,
                Motion::Hide => HIDE_MS,
                Motion::Resize => RESIZE_MS,
                Motion::None => return 1.0,
            };
            (self.start.elapsed().as_secs_f32() * 1000.0 / span).clamp(0.0, 1.0)
        }

        fn begin(&mut self, motion: Motion, already_done: f32) {
            let span = match motion {
                Motion::Show => SHOW_MS,
                Motion::Hide => HIDE_MS,
                Motion::Resize => RESIZE_MS,
                Motion::None => 0.0,
            };
            let back = std::time::Duration::from_secs_f32(already_done * span / 1000.0);
            self.motion = motion;
            self.start = std::time::Instant::now()
                .checked_sub(back)
                .unwrap_or_else(std::time::Instant::now);
        }
    }

    unsafe fn render(hwnd: HWND) {
        let started = std::time::Instant::now();
        let live = current_state();
        let (state, motion, progress) = ANIM.with(|cell| {
            let anim = cell.borrow();
            let state = if matches!(live, PillState::Hidden) {
                anim.visible_state.clone()
            } else {
                live.clone()
            };
            (state, anim.motion, anim.progress())
        });
        // Hidden only stops the drawing once the hide transition has run.
        if matches!(state, PillState::Hidden) {
            return;
        }
        if matches!(live, PillState::Hidden) && motion != Motion::Hide {
            return;
        }

        let dpi = {
            let value = GetDpiForWindow(hwnd);
            if value == 0 {
                96
            } else {
                value
            }
        };
        let scale = (dpi as f32 / 96.0) * user_scale();

        SURFACE.with(|cell| {
            let mut slot = cell.borrow_mut();
            if slot.is_none() {
                let dc = CreateCompatibleDC(None);
                if dc.is_invalid() {
                    return;
                }
                *slot = Some(Surface {
                    dc,
                    bitmap: HBITMAP::default(),
                    old_bitmap: HGDIOBJ::default(),
                    bits: std::ptr::null_mut(),
                    width: 0,
                    height: 0,
                    byte_count: 0,
                    font: HGDIOBJ::default(),
                    font_scale_bits: 0,
                    base: Vec::new(),
                    base_key: None,
                    alpha_scratch: Vec::new(),
                    measure_key: None,
                    measure: (0.0, 0.0),
                });
            }
            if let Some(surface) = slot.as_mut() {
                paint(hwnd, surface, &state, scale, motion, progress);
            }
        });

        record_render(started.elapsed().as_nanos() as u64);
    }

    unsafe fn paint(
        hwnd: HWND,
        surface: &mut Surface,
        state: &PillState,
        scale: f32,
        motion: Motion,
        progress: f32,
    ) {
        let scale_bits = scale.to_bits();
        let text = match state {
            PillState::Recording { live_text, .. } => live_text.clone(),
            PillState::Error { message, .. } => message.clone(),
            _ => String::new(),
        };
        let is_error = matches!(state, PillState::Error { .. });

        // Font, only rebuilt when the scale changes.
        if surface.font_scale_bits != scale_bits || surface.font.is_invalid() {
            let font = make_font(scale, TEXT_SIZE);
            SelectObject(surface.dc, font);
            if !surface.font.is_invalid() {
                let _ = DeleteObject(surface.font);
            }
            surface.font = font;
            surface.font_scale_bits = scale_bits;
            surface.base_key = None;
            surface.measure_key = None;
        }

        // Text measurement, only redone when the text or the scale changed.
        let measure_key = Some((text.clone(), scale_bits, is_error));
        if surface.measure_key != measure_key {
            let mut width = 0.0f32;
            let mut height = 0.0f32;
            if !text.is_empty() {
                let mut wide: Vec<u16> = text.encode_utf16().collect();
                let mut rect = RECT {
                    left: 0,
                    top: 0,
                    right: ((PANEL_MAX_WIDTH - 2.0 * TEXT_PADDING) * scale) as i32,
                    bottom: 0,
                };
                let format = if is_error {
                    DT_SINGLELINE | DT_NOPREFIX | DT_CALCRECT
                } else {
                    DT_WORDBREAK | DT_NOPREFIX | DT_CALCRECT
                };
                DrawTextW(surface.dc, &mut wide, &mut rect, format);
                width = (rect.right - rect.left) as f32;
                height = (rect.bottom - rect.top) as f32;
            }
            surface.measure = (width, height);
            surface.measure_key = measure_key;
        }
        let (text_width, total_height) = surface.measure;
        let visible_height = if is_error {
            0.0
        } else {
            total_height.min(TEXT_LINE_HEIGHT * scale * TEXT_MAX_LINES)
        };

        // The shape this state settles on.
        let rest = shape_metrics(state, scale, text_width, visible_height);

        // A size change while sitting still starts a grow or shrink.
        let mut motion = motion;
        let mut progress = progress;
        if motion == Motion::None {
            let started = ANIM.with(|cell| {
                let mut anim = cell.borrow_mut();
                if anim.last_scale_bits != scale_bits {
                    return false;
                }
                match anim.last_shape {
                    Some(previous)
                        if (previous.0 - rest.0).abs() > 0.5
                            || (previous.1 - rest.1).abs() > 0.5 =>
                    {
                        anim.from_shape = previous;
                        anim.begin(Motion::Resize, 0.0);
                        true
                    }
                    _ => false,
                }
            });
            if started {
                motion = Motion::Resize;
                progress = 0.0;
                log::debug!("pill: resize to {:.0}x{:.0}", rest.0, rest.1);
                sync_timer(hwnd);
            }
        }

        // Geometry for this frame, plus the opacity it is drawn with.
        let (shape, effective_scale, opacity, window_width, window_height) = match motion {
            Motion::Show | Motion::Hide => {
                let (factor, alpha) = if motion == Motion::Show {
                    (show_scale(progress), show_alpha(progress))
                } else {
                    (hide_scale(progress), hide_alpha(progress))
                };
                // Sized for the overshoot so the peak frame is never clipped.
                let (width, height) =
                    window_size_for(rest.0 * SHOW_PEAK, rest.1 * SHOW_PEAK, scale);
                (
                    (
                        rest.0 * factor,
                        rest.1 * factor,
                        rest.2 * factor,
                        rest.3 * factor,
                    ),
                    scale * factor,
                    alpha,
                    width,
                    height,
                )
            }
            Motion::Resize => {
                let from = ANIM.with(|cell| cell.borrow().from_shape);
                let eased = ease_out_cubic(progress);
                let mix = |a: f32, b: f32| a + (b - a) * eased;
                let (width, height) =
                    window_size_for(rest.0.max(from.0), rest.1.max(from.1), scale);
                (
                    (
                        mix(from.0, rest.0),
                        mix(from.1, rest.1),
                        mix(from.2, rest.2),
                        mix(from.3, rest.3),
                    ),
                    scale,
                    1.0,
                    width,
                    height,
                )
            }
            Motion::None => {
                let (width, height) = window_size_for(rest.0, rest.1, scale);
                (rest, scale, 1.0, width, height)
            }
        };

        let layout = layout_with(
            shape.0,
            shape.1,
            shape.2,
            shape.3,
            window_width,
            window_height,
            effective_scale,
        );

        // The DIB, only rebuilt when the window size changes.
        if surface.width != layout.window_width || surface.height != layout.window_height {
            let header = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: layout.window_width,
                    // Negative height: top-down rows, same order as our canvas.
                    biHeight: -layout.window_height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let Ok(bitmap) =
                CreateDIBSection(surface.dc, &header, DIB_RGB_COLORS, &mut bits, None, 0)
            else {
                return;
            };
            let old = SelectObject(surface.dc, HGDIOBJ(bitmap.0));
            if surface.bitmap.is_invalid() {
                surface.old_bitmap = old;
            } else {
                let _ = DeleteObject(HGDIOBJ(surface.bitmap.0));
            }
            surface.bitmap = bitmap;
            surface.bits = bits as *mut u8;
            surface.width = layout.window_width;
            surface.height = layout.window_height;
            surface.byte_count = (layout.window_width * layout.window_height * 4) as usize;
            surface.base_key = None;
        }
        if surface.bits.is_null() || surface.byte_count == 0 {
            return;
        }

        if motion == Motion::None {
            // At rest: the static layer is cached and only the dots are redrawn.
            let key = CacheKey {
                width: layout.window_width,
                height: layout.window_height,
                kind: kind_of(state),
                scale_bits,
                text: text.clone(),
            };
            if surface.base_key.as_ref() != Some(&key) {
                surface.base.clear();
                surface.base.resize(surface.byte_count, 0);
                {
                    let mut canvas =
                        Canvas::wrap(layout.window_width, layout.window_height, &mut surface.base);
                    draw_static(&mut canvas, state, &layout);
                }
                std::ptr::copy_nonoverlapping(
                    surface.base.as_ptr(),
                    surface.bits,
                    surface.byte_count,
                );

                if !text.is_empty() {
                    draw_text(surface, &layout, &text, is_error, total_height, scale);
                    let _ = GdiFlush();
                    // GDI clears the alpha byte of every pixel it touches.
                    for index in (3..surface.byte_count).step_by(4) {
                        *surface.bits.add(index) = surface.base[index];
                    }
                    std::ptr::copy_nonoverlapping(
                        surface.bits,
                        surface.base.as_mut_ptr(),
                        surface.byte_count,
                    );
                }
                surface.base_key = Some(key);
            }
            std::ptr::copy_nonoverlapping(surface.base.as_ptr(), surface.bits, surface.byte_count);
        } else {
            // While moving, the geometry changes every frame, so compose fresh.
            std::ptr::write_bytes(surface.bits, 0, surface.byte_count);
            {
                let pixels = std::slice::from_raw_parts_mut(surface.bits, surface.byte_count);
                let mut canvas = Canvas::wrap(layout.window_width, layout.window_height, pixels);
                draw_static(&mut canvas, state, &layout);
            }
            // Text keeps its own size; it is only drawn while the shape is not
            // scaled, so it does not blur during the appear and disappear.
            if !text.is_empty() && motion == Motion::Resize {
                surface.alpha_scratch.clear();
                surface.alpha_scratch.extend(
                    (3..surface.byte_count)
                        .step_by(4)
                        .map(|i| *surface.bits.add(i)),
                );
                draw_text(surface, &layout, &text, is_error, total_height, scale);
                let _ = GdiFlush();
                for (slot, index) in (3..surface.byte_count).step_by(4).enumerate() {
                    *surface.bits.add(index) = surface.alpha_scratch[slot];
                }
            }
        }

        {
            let pixels = std::slice::from_raw_parts_mut(surface.bits, surface.byte_count);
            let mut canvas = Canvas::wrap(layout.window_width, layout.window_height, pixels);
            draw_dynamic(&mut canvas, state, &layout, FRAME.load(Ordering::Relaxed));
        }

        // Fade: the buffer is premultiplied, so scaling all four channels is
        // exactly a change of opacity.
        if opacity < 0.999 {
            let factor = (opacity.clamp(0.0, 1.0) * 256.0) as u32;
            let pixels = std::slice::from_raw_parts_mut(surface.bits, surface.byte_count);
            for byte in pixels.iter_mut() {
                *byte = ((*byte as u32 * factor) >> 8) as u8;
            }
        }

        // Remember the shape this state settles on, on every frame. Comparing
        // the target (not the animated shape) means a level update never starts
        // a transition and a text change starts exactly one resize.
        ANIM.with(|cell| {
            let mut anim = cell.borrow_mut();
            anim.last_shape = Some(rest);
            anim.last_scale_bits = scale_bits;
        });

        // Position: bottom center of the primary work area. The shape always
        // sits one shadow margin above the window bottom, so the resting edge
        // stays put no matter how big the window is.
        let area = work_area();
        let x = area.left + (area.right - area.left - layout.window_width) / 2;
        let y = area.bottom - (BOTTOM_OFFSET * scale) as i32 - layout.window_height
            + (SHADOW_MARGIN * scale) as i32;

        let point_dst = POINT { x, y };
        let size = SIZE {
            cx: layout.window_width,
            cy: layout.window_height,
        };
        let point_src = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };

        // A null destination DC means the screen DC, so no GetDC per frame.
        let _ = UpdateLayeredWindow(
            hwnd,
            None,
            Some(&point_dst),
            Some(&size),
            surface.dc,
            Some(&point_src),
            COLORREF(0),
            Some(&blend),
            ULW_ALPHA,
        );
    }

    unsafe fn draw_text(
        surface: &Surface,
        layout: &Layout,
        text: &str,
        is_error: bool,
        total_height: f32,
        scale: f32,
    ) {
        let mut wide: Vec<u16> = text.encode_utf16().collect();
        // Text goes into a premultiplied buffer, so the color is multiplied by
        // the glass alpha and the text alpha up front.
        let value = (255.0 * TEXT_ALPHA * GLASS_ALPHA).round() as u32;
        let text_color = COLORREF(value | (value << 8) | (value << 16));
        SetBkMode(surface.dc, TRANSPARENT);
        SetTextColor(surface.dc, text_color);

        if is_error {
            let inset = TEXT_PADDING * scale;
            let mut rect = RECT {
                left: (layout.shape_x + inset) as i32,
                top: layout.shape_y as i32,
                right: (layout.shape_x + layout.shape_width - inset) as i32,
                bottom: (layout.shape_y + layout.shape_height) as i32,
            };
            DrawTextW(
                surface.dc,
                &mut wide,
                &mut rect,
                DT_SINGLELINE | DT_NOPREFIX | DT_CENTER | DT_VCENTER | DT_END_ELLIPSIS,
            );
        } else if let Some((tx, ty, tw, th)) = layout.text_area {
            // Older lines scroll out of view at the top.
            let overflow = (total_height - th).max(0.0);
            IntersectClipRect(
                surface.dc,
                tx as i32,
                ty as i32,
                (tx + tw).ceil() as i32,
                (ty + th).ceil() as i32,
            );
            let mut rect = RECT {
                left: tx as i32,
                top: (ty - overflow) as i32,
                right: (tx + tw).ceil() as i32,
                bottom: (ty + total_height).ceil() as i32,
            };
            DrawTextW(surface.dc, &mut wide, &mut rect, DT_WORDBREAK | DT_NOPREFIX);
            let _ = SelectClipRgn(surface.dc, None);
        }
    }

    pub fn make_dpi_aware() {
        unsafe {
            // Best effort: Tauri already does this in the app, the demo does not.
            let _ = windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
                windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            );
        }
    }
}

// ------------------------------------------------------------------ Linux

/// Linux (Wayland first, Hyprland in mind): a GTK3 window turned into a
/// wlr-layer-shell surface on the overlay layer, anchored bottom center, never
/// taking keyboard focus. The pixels come from the same Canvas rasterizer as on
/// Windows, copied into a cairo ARGB32 image (same premultiplied BGRA byte
/// order on little endian); text is laid out with pango. Without layer-shell
/// support it falls back to an undecorated, non-focusable keep-above window.
/// Everything here runs on the GTK main thread; other threads only touch the
/// shared state cell and schedule `apply_state` through the main context.
#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use gtk::prelude::*;
    use gtk::{cairo, gdk, glib, pango};
    use gtk_layer_shell::LayerShell;
    use std::cell::RefCell;
    use std::time::Duration;

    const DONE_VISIBLE_MS: u64 = 600;
    /// Animation tick while something moves.
    const FRAME_MS: u64 = 16;
    /// Same text opacity as on Windows.
    const TEXT_ALPHA: f32 = 0.92;
    /// Fontconfig resolves this to the system UI sans (Segoe UI on Windows).
    const FONT_FAMILY: &str = "Sans";

    // The safe binding for this needs the crate feature `v0_5`; the symbol is in
    // every gtk-layer-shell >= 0.5, which gtk-layer-shell-sys already links.
    extern "C" {
        fn gtk_layer_is_supported() -> std::os::raw::c_int;
    }

    struct Surface {
        window: gtk::Window,
        /// True when the window is a layer-shell surface.
        layer: bool,
        /// The frame shown by the draw handler, in physical pixels.
        frame: Option<cairo::ImageSurface>,
        width: i32,
        height: i32,
        /// Shadow, glass, rim and the baked text; everything but the moving parts.
        base: Vec<u8>,
        base_key: Option<CacheKey>,
        measure_key: Option<(String, u32, bool)>,
        measure: (f32, f32),
        /// Last logical window size, bottom margin and input rectangle applied.
        window_size: (i32, i32),
        margin: i32,
        input_rect: Option<(i32, i32, i32, i32)>,
        retry_cursor: Option<bool>,
    }

    #[derive(PartialEq, Clone)]
    struct CacheKey {
        width: i32,
        height: i32,
        kind: u8,
        scale_bits: u32,
        text: String,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Motion {
        None,
        Show,
        Hide,
        Resize,
    }

    /// Same transition bookkeeping as the Win32 pill.
    struct Anim {
        motion: Motion,
        start: std::time::Instant,
        from_shape: (f32, f32, f32, f32),
        visible_state: PillState,
        visible: bool,
        last_shape: Option<(f32, f32, f32, f32)>,
        last_scale_bits: u32,
    }

    impl Anim {
        fn new() -> Anim {
            Anim {
                motion: Motion::None,
                start: std::time::Instant::now(),
                from_shape: (0.0, 0.0, 0.0, 0.0),
                visible_state: PillState::Hidden,
                visible: false,
                last_shape: None,
                last_scale_bits: 0,
            }
        }

        fn progress(&self) -> f32 {
            let span = match self.motion {
                Motion::Show => SHOW_MS,
                Motion::Hide => HIDE_MS,
                Motion::Resize => RESIZE_MS,
                Motion::None => return 1.0,
            };
            (self.start.elapsed().as_secs_f32() * 1000.0 / span).clamp(0.0, 1.0)
        }

        fn begin(&mut self, motion: Motion, already_done: f32) {
            let span = match motion {
                Motion::Show => SHOW_MS,
                Motion::Hide => HIDE_MS,
                Motion::Resize => RESIZE_MS,
                Motion::None => 0.0,
            };
            let back = Duration::from_secs_f32(already_done * span / 1000.0);
            self.motion = motion;
            self.start = std::time::Instant::now()
                .checked_sub(back)
                .unwrap_or_else(std::time::Instant::now);
        }
    }

    thread_local! {
        static SURFACE: RefCell<Option<Surface>> = const { RefCell::new(None) };
        static ANIM: RefCell<Anim> = RefCell::new(Anim::new());
        static TICK: RefCell<Option<glib::SourceId>> = const { RefCell::new(None) };
        static HIDE_TIMER: RefCell<Option<glib::SourceId>> = const { RefCell::new(None) };
    }

    pub fn start(
        cancel: Box<dyn Fn() + Send>,
        confirm: Box<dyn Fn() + Send>,
    ) -> Result<(), String> {
        let _ = CALLBACKS.set(Mutex::new(Callbacks { cancel, confirm }));
        if gtk::is_initialized_main_thread() {
            create_window()
        } else if gtk::is_initialized() {
            glib::idle_add_once(|| {
                if let Err(error) = create_window() {
                    log::error!("the pill window could not be created: {error}");
                }
            });
            Ok(())
        } else {
            Err("GTK is not initialized; the pill needs the GTK main loop.".to_string())
        }
    }

    /// Schedules a state update on the GTK main thread. Never runs inline, so
    /// a caller on the main thread cannot re-enter a running render.
    pub fn notify() {
        if STARTED.load(Ordering::SeqCst) {
            glib::idle_add_once(apply_state);
        }
    }

    fn layer_shell_supported() -> bool {
        unsafe { gtk_layer_is_supported() != 0 }
    }

    pub(super) fn create_window() -> Result<(), String> {
        if SURFACE.with(|cell| cell.borrow().is_some()) {
            return Ok(());
        }
        let display = gdk::Display::default().ok_or("No display for the pill window")?;
        let layer = layer_shell_supported();
        let x11 = display.type_().name().contains("X11");
        // On X11 an override-redirect popup is the reliable way to sit on top
        // without focus; on Wayland a popup needs a parent, so use a toplevel.
        let kind = if !layer && x11 {
            gtk::WindowType::Popup
        } else {
            gtk::WindowType::Toplevel
        };
        let window = gtk::Window::new(kind);
        window.set_title("Spechy");
        window.set_decorated(false);
        window.set_resizable(false);
        window.set_accept_focus(false);
        window.set_focus_on_map(false);
        window.set_skip_taskbar_hint(true);
        window.set_skip_pager_hint(true);
        window.set_app_paintable(true);
        if let Some(visual) = display.default_screen().rgba_visual() {
            window.set_visual(Some(&visual));
        } else {
            log::warn!("pill: no RGBA visual, the pill will not be transparent");
        }

        if layer {
            window.init_layer_shell();
            window.set_namespace("spechy-pill");
            window.set_layer(gtk_layer_shell::Layer::Overlay);
            window.set_anchor(gtk_layer_shell::Edge::Bottom, true);
            window.set_keyboard_interactivity(false);
            window.set_exclusive_zone(0);
        } else {
            log::warn!("pill: layer-shell not supported, using a keep-above window");
            window.set_keep_above(true);
            window.set_type_hint(gdk::WindowTypeHint::Notification);
        }

        window.add_events(gdk::EventMask::BUTTON_PRESS_MASK);
        window.connect_draw(|widget, cr| {
            cr.set_operator(cairo::Operator::Source);
            cr.set_source_rgba(0.0, 0.0, 0.0, 0.0);
            let _ = cr.paint();
            SURFACE.with(|cell| {
                let Ok(slot) = cell.try_borrow() else { return };
                let Some(surface) = slot.as_ref() else { return };
                let Some(frame) = surface.frame.as_ref() else {
                    return;
                };
                let dev = widget.scale_factor().max(1) as f64;
                let (x, y) = frame_origin(widget, surface);
                cr.save().ok();
                cr.scale(1.0 / dev, 1.0 / dev);
                if cr.set_source_surface(frame, x, y).is_ok() {
                    let _ = cr.paint();
                }
                // Restoring drops the reference to the frame, so the next
                // render gets exclusive access to its pixels again.
                cr.restore().ok();
            });
            glib::Propagation::Stop
        });
        window.connect_button_press_event(|widget, event| {
            on_button_press(widget, event);
            glib::Propagation::Stop
        });
        window.connect_scale_factor_notify(|_| notify());

        SURFACE.with(|cell| {
            *cell.borrow_mut() = Some(Surface {
                window,
                layer,
                frame: None,
                width: 0,
                height: 0,
                base: Vec::new(),
                base_key: None,
                measure_key: None,
                measure: (0.0, 0.0),
                window_size: (0, 0),
                margin: -1,
                input_rect: None,
                retry_cursor: None,
            });
        });
        Ok(())
    }

    /// Where the frame's top left sits in the window, in physical pixels. The
    /// shape lives at the bottom center of the frame and the window is anchored
    /// bottom center, so aligning bottom centers keeps the pill in place even
    /// for the frame or two before the compositor applied a new window size.
    fn frame_origin(widget: &gtk::Window, surface: &Surface) -> (f64, f64) {
        let dev = widget.scale_factor().max(1) as f64;
        let alloc_width = widget.allocated_width() as f64 * dev;
        let alloc_height = widget.allocated_height() as f64 * dev;
        (
            ((alloc_width - surface.width as f64) / 2.0).round(),
            alloc_height - surface.height as f64,
        )
    }

    fn on_button_press(widget: &gtk::Window, event: &gdk::EventButton) {
        // Windows reacts to WM_LBUTTONDOWN only; GTK also sends 2BUTTON_PRESS.
        if event.button() != 1 || event.event_type() != gdk::EventType::ButtonPress {
            return;
        }
        if offers_retry() {
            // The handler touches pipeline state and calls back into set_state.
            std::thread::spawn(|| {
                if let Some(cell) = RETRY_HANDLER.get() {
                    if let Ok(handler) = cell.lock() {
                        (handler)();
                    }
                }
            });
            return;
        }
        let origin = SURFACE.with(|cell| {
            cell.try_borrow()
                .ok()
                .and_then(|slot| slot.as_ref().map(|surface| frame_origin(widget, surface)))
        });
        let Some((origin_x, origin_y)) = origin else {
            return;
        };
        let dev = widget.scale_factor().max(1) as f64;
        let (event_x, event_y) = event.position();
        let x = (event_x * dev - origin_x) as f32;
        let y = (event_y * dev - origin_y) as f32;
        let areas = hit_areas().lock().map(|guard| *guard).unwrap_or_default();
        if !areas.active {
            return;
        }
        let inside =
            |area: (f32, f32, f32)| ((x - area.0).powi(2) + (y - area.1).powi(2)).sqrt() <= area.2;
        // Off the GTK thread: the pipeline may block or wait for the main loop.
        if inside(areas.cancel) {
            std::thread::spawn(|| {
                if let Some(cell) = CALLBACKS.get() {
                    if let Ok(callbacks) = cell.lock() {
                        (callbacks.cancel)();
                    }
                }
            });
        } else if inside(areas.confirm) {
            std::thread::spawn(|| {
                if let Some(cell) = CALLBACKS.get() {
                    if let Ok(callbacks) = cell.lock() {
                        (callbacks.confirm)();
                    }
                }
            });
        }
    }

    fn arm_hide_timer() {
        cancel_hide_timer();
        let id = glib::timeout_add_local_once(Duration::from_millis(DONE_VISIBLE_MS), || {
            // Fired: the source is gone, only forget its id.
            HIDE_TIMER.with(|cell| cell.borrow_mut().take());
            if matches!(current_state(), PillState::Done) {
                let next = if ALWAYS_VISIBLE.load(Ordering::SeqCst) {
                    PillState::Idle
                } else {
                    PillState::Hidden
                };
                if let Ok(mut guard) = state_cell().lock() {
                    *guard = next;
                }
                apply_state();
            }
        });
        HIDE_TIMER.with(|cell| *cell.borrow_mut() = Some(id));
    }

    fn cancel_hide_timer() {
        if let Some(id) = HIDE_TIMER.with(|cell| cell.borrow_mut().take()) {
            id.remove();
        }
    }

    fn window() -> Option<gtk::Window> {
        SURFACE.with(|cell| cell.borrow().as_ref().map(|surface| surface.window.clone()))
    }

    fn hide_window() {
        if let Some(window) = window() {
            window.hide();
        }
    }

    pub(super) fn apply_state() {
        STAT_UPDATES.fetch_add(1, Ordering::Relaxed);
        let Some(window) = window() else { return };
        let state = current_state();

        // Arm the hide timer exactly once per Done, drop it in every other state.
        if matches!(state, PillState::Done) {
            arm_hide_timer();
        } else {
            cancel_hide_timer();
        }

        // A late Done, after the pill is gone or already on its way out, is the
        // tail of a finished dictation: it must not pop the pill back up.
        if matches!(state, PillState::Done) {
            let stale = ANIM.with(|cell| {
                let anim = cell.borrow();
                !anim.visible || anim.motion == Motion::Hide
            });
            if stale {
                cancel_hide_timer();
                if let Ok(mut guard) = state_cell().lock() {
                    if matches!(*guard, PillState::Done) {
                        *guard = PillState::Hidden;
                    }
                }
                return;
            }
        }

        let state = current_state();
        let hiding = ANIM.with(|cell| {
            let mut anim = cell.borrow_mut();
            if matches!(state, PillState::Hidden) {
                if !anim.visible {
                    anim.motion = Motion::None;
                    return false;
                }
                if anim.motion != Motion::Hide {
                    let done = if anim.motion == Motion::Show {
                        invert(hide_scale, show_scale(anim.progress()))
                    } else {
                        0.0
                    };
                    anim.begin(Motion::Hide, done);
                }
                true
            } else {
                anim.visible_state = state.clone();
                if !anim.visible {
                    anim.visible = true;
                    anim.last_shape = None;
                    anim.begin(Motion::Show, 0.0);
                } else if anim.motion == Motion::Hide {
                    let done = invert(show_scale, hide_scale(anim.progress()));
                    anim.begin(Motion::Show, done);
                }
                false
            }
        });

        if matches!(state, PillState::Hidden) && !hiding {
            sync_timer();
            hide_window();
            return;
        }

        render();
        update_cursor(&window);
        if !window.is_visible() {
            window.show();
        }
        if let Some(gdk_window) = window.window() {
            gdk_window.raise();
        }
        sync_timer();
    }

    fn update_cursor(window: &gtk::Window) {
        let retry = offers_retry();
        let changed = SURFACE.with(|cell| {
            let mut slot = cell.borrow_mut();
            let Some(surface) = slot.as_mut() else {
                return false;
            };
            let changed = surface.retry_cursor != Some(retry);
            surface.retry_cursor = Some(retry);
            changed
        });
        if !changed {
            return;
        }
        // Not realized yet: the next state change sets it.
        let Some(gdk_window) = window.window() else {
            SURFACE.with(|cell| {
                if let Some(surface) = cell.borrow_mut().as_mut() {
                    surface.retry_cursor = None;
                }
            });
            return;
        };
        let cursor = if retry {
            gdk::Cursor::from_name(&gdk_window.display(), "pointer")
        } else {
            None
        };
        gdk_window.set_cursor(cursor.as_ref());
    }

    /// The tick runs while a state animates or a transition is live.
    fn sync_timer() {
        let wanted = kind_animates(kind_of(&current_state()))
            || ANIM.with(|cell| cell.borrow().motion != Motion::None);
        TICK.with(|cell| {
            let mut slot = cell.borrow_mut();
            if wanted {
                if slot.is_none() {
                    *slot = Some(glib::timeout_add_local(
                        Duration::from_millis(FRAME_MS),
                        tick,
                    ));
                }
            } else if let Some(id) = slot.take() {
                // Also fine from inside the tick itself: GLib destroys the
                // running source once it returns.
                id.remove();
            }
        });
    }

    fn tick() -> glib::ControlFlow {
        FRAME.fetch_add(1, Ordering::Relaxed);
        render();
        finish_transition();
        // sync_timer is the only owner of the source and removes it when idle.
        sync_timer();
        glib::ControlFlow::Continue
    }

    fn finish_transition() {
        let hide_now = ANIM.with(|cell| {
            let mut anim = cell.borrow_mut();
            if anim.motion == Motion::None || anim.progress() < 1.0 {
                return false;
            }
            let was_hide = anim.motion == Motion::Hide;
            anim.motion = Motion::None;
            if was_hide {
                anim.visible = false;
                anim.last_shape = None;
            }
            was_hide
        });
        if hide_now {
            hide_window();
        }
    }

    fn render() {
        let started = std::time::Instant::now();
        let live = current_state();
        let (state, motion, progress) = ANIM.with(|cell| {
            let anim = cell.borrow();
            let state = if matches!(live, PillState::Hidden) {
                anim.visible_state.clone()
            } else {
                live.clone()
            };
            (state, anim.motion, anim.progress())
        });
        if matches!(state, PillState::Hidden) {
            return;
        }
        if matches!(live, PillState::Hidden) && motion != Motion::Hide {
            return;
        }

        let started_resize = SURFACE.with(|cell| {
            let mut slot = cell.borrow_mut();
            let Some(surface) = slot.as_mut() else {
                return false;
            };
            paint(surface, &state, motion, progress)
        });
        if started_resize {
            sync_timer();
        }
        record_render(started.elapsed().as_nanos() as u64);
    }

    fn font_description(scale: f32) -> pango::FontDescription {
        let mut description = pango::FontDescription::from_string(FONT_FAMILY);
        description.set_weight(pango::Weight::Normal);
        // Absolute size is in device pixels, like CreateFontW's negative height.
        description.set_absolute_size((TEXT_SIZE * scale) as f64 * pango::SCALE as f64);
        description
    }

    fn text_layout(window: &gtk::Window, text: &str, scale: f32) -> pango::Layout {
        let layout = window.create_pango_layout(Some(text));
        layout.set_font_description(Some(&font_description(scale)));
        layout
    }

    /// Rounds a physical size up to whole logical pixels.
    fn round_up(value: i32, multiple: i32) -> i32 {
        (value + multiple - 1) / multiple * multiple
    }

    /// Paints one frame; returns true when it started a resize transition.
    fn paint(surface: &mut Surface, state: &PillState, motion: Motion, progress: f32) -> bool {
        let window = surface.window.clone();
        let dev = window.scale_factor().max(1);
        let scale = dev as f32 * user_scale();
        let scale_bits = scale.to_bits();
        let text = match state {
            PillState::Recording { live_text, .. } => live_text.clone(),
            PillState::Error { message, .. } => message.clone(),
            _ => String::new(),
        };
        let is_error = matches!(state, PillState::Error { .. });

        // Text measurement, only redone when the text or the scale changed.
        let measure_key = Some((text.clone(), scale_bits, is_error));
        if surface.measure_key != measure_key {
            let mut size = (0.0f32, 0.0f32);
            if !text.is_empty() {
                let layout = text_layout(&window, &text, scale);
                if is_error {
                    layout.set_single_paragraph_mode(true);
                } else {
                    layout.set_width(
                        ((PANEL_MAX_WIDTH - 2.0 * TEXT_PADDING) * scale) as i32 * pango::SCALE,
                    );
                    layout.set_wrap(pango::WrapMode::WordChar);
                }
                let (width, height) = layout.pixel_size();
                size = (width as f32, height as f32);
            }
            surface.measure = size;
            surface.measure_key = measure_key;
            surface.base_key = None;
        }
        let (text_width, total_height) = surface.measure;
        let visible_height = if is_error {
            0.0
        } else {
            total_height.min(TEXT_LINE_HEIGHT * scale * TEXT_MAX_LINES)
        };

        let rest = shape_metrics(state, scale, text_width, visible_height);

        // A size change while sitting still starts a grow or shrink.
        let mut motion = motion;
        let mut progress = progress;
        let mut started_resize = false;
        if motion == Motion::None {
            started_resize = ANIM.with(|cell| {
                let mut anim = cell.borrow_mut();
                if anim.last_scale_bits != scale_bits {
                    return false;
                }
                match anim.last_shape {
                    Some(previous)
                        if (previous.0 - rest.0).abs() > 0.5
                            || (previous.1 - rest.1).abs() > 0.5 =>
                    {
                        anim.from_shape = previous;
                        anim.begin(Motion::Resize, 0.0);
                        true
                    }
                    _ => false,
                }
            });
            if started_resize {
                motion = Motion::Resize;
                progress = 0.0;
                log::debug!("pill: resize to {:.0}x{:.0}", rest.0, rest.1);
            }
        }

        let (shape, effective_scale, opacity, window_width, window_height) = match motion {
            Motion::Show | Motion::Hide => {
                let (factor, alpha) = if motion == Motion::Show {
                    (show_scale(progress), show_alpha(progress))
                } else {
                    (hide_scale(progress), hide_alpha(progress))
                };
                let (width, height) =
                    window_size_for(rest.0 * SHOW_PEAK, rest.1 * SHOW_PEAK, scale);
                (
                    (
                        rest.0 * factor,
                        rest.1 * factor,
                        rest.2 * factor,
                        rest.3 * factor,
                    ),
                    scale * factor,
                    alpha,
                    width,
                    height,
                )
            }
            Motion::Resize => {
                let from = ANIM.with(|cell| cell.borrow().from_shape);
                let eased = ease_out_cubic(progress);
                let mix = |a: f32, b: f32| a + (b - a) * eased;
                let (width, height) =
                    window_size_for(rest.0.max(from.0), rest.1.max(from.1), scale);
                (
                    (
                        mix(from.0, rest.0),
                        mix(from.1, rest.1),
                        mix(from.2, rest.2),
                        mix(from.3, rest.3),
                    ),
                    scale,
                    1.0,
                    width,
                    height,
                )
            }
            Motion::None => {
                let (width, height) = window_size_for(rest.0, rest.1, scale);
                (rest, scale, 1.0, width, height)
            }
        };

        let layout = layout_with(
            shape.0,
            shape.1,
            shape.2,
            shape.3,
            round_up(window_width, dev),
            round_up(window_height, dev),
            effective_scale,
        );

        // The frame image, only rebuilt when the window size changes.
        if surface.width != layout.window_width
            || surface.height != layout.window_height
            || surface.frame.is_none()
        {
            match cairo::ImageSurface::create(
                cairo::Format::ARgb32,
                layout.window_width,
                layout.window_height,
            ) {
                Ok(frame) if frame.stride() == layout.window_width * 4 => {
                    surface.frame = Some(frame);
                }
                Ok(_) => {
                    log::error!("pill: unexpected cairo stride");
                    return started_resize;
                }
                Err(error) => {
                    log::error!("pill: could not create the frame: {error}");
                    return started_resize;
                }
            }
            surface.width = layout.window_width;
            surface.height = layout.window_height;
            surface.base_key = None;
        }
        let byte_count = (layout.window_width * layout.window_height * 4) as usize;
        let Some(mut frame) = surface.frame.take() else {
            return started_resize;
        };

        if motion == Motion::None {
            // At rest: the static layer (with the text) is cached and only the
            // moving parts are redrawn.
            let key = CacheKey {
                width: layout.window_width,
                height: layout.window_height,
                kind: kind_of(state),
                scale_bits,
                text: text.clone(),
            };
            if surface.base_key.as_ref() != Some(&key) {
                surface.base.clear();
                surface.base.resize(byte_count, 0);
                {
                    let mut canvas =
                        Canvas::wrap(layout.window_width, layout.window_height, &mut surface.base);
                    draw_static(&mut canvas, state, &layout);
                }
                let base = &surface.base;
                with_pixels(&mut frame, |pixels| pixels[..byte_count].copy_from_slice(base));
                if !text.is_empty() {
                    draw_text(&window, &frame, &layout, &text, is_error, total_height, scale);
                    let base = &mut surface.base;
                    with_pixels(&mut frame, |pixels| base.copy_from_slice(&pixels[..byte_count]));
                }
                surface.base_key = Some(key);
            } else {
                let base = &surface.base;
                with_pixels(&mut frame, |pixels| pixels[..byte_count].copy_from_slice(base));
            }
        } else {
            // While moving, the geometry changes every frame, so compose fresh.
            with_pixels(&mut frame, |pixels| {
                pixels[..byte_count].fill(0);
                let mut canvas =
                    Canvas::wrap(layout.window_width, layout.window_height, pixels);
                draw_static(&mut canvas, state, &layout);
            });
            // Text only while the shape is not scaled, as on Windows.
            if !text.is_empty() && motion == Motion::Resize {
                draw_text(&window, &frame, &layout, &text, is_error, total_height, scale);
            }
        }

        with_pixels(&mut frame, |pixels| {
            {
                let mut canvas = Canvas::wrap(
                    layout.window_width,
                    layout.window_height,
                    &mut pixels[..byte_count],
                );
                draw_dynamic(&mut canvas, state, &layout, FRAME.load(Ordering::Relaxed));
            }
            // Premultiplied: scaling all four channels is a change of opacity.
            if opacity < 0.999 {
                let factor = (opacity.clamp(0.0, 1.0) * 256.0) as u32;
                for byte in pixels.iter_mut() {
                    *byte = ((*byte as u32 * factor) >> 8) as u8;
                }
            }
        });
        surface.frame = Some(frame);

        ANIM.with(|cell| {
            let mut anim = cell.borrow_mut();
            anim.last_shape = Some(rest);
            anim.last_scale_bits = scale_bits;
        });

        place_window(surface, &layout, rest, dev);
        window.queue_draw();
        started_resize
    }

    /// Runs `f` on the frame's pixels (exclusive access, marked dirty after).
    fn with_pixels(frame: &mut cairo::ImageSurface, f: impl FnOnce(&mut [u8])) {
        frame.flush();
        match frame.data() {
            Ok(mut data) => f(&mut data),
            Err(error) => log::warn!("pill: frame busy: {error}"),
        }
    }

    /// Window size, bottom margin and click area, applied only on change.
    fn place_window(surface: &mut Surface, layout: &Layout, rest: (f32, f32, f32, f32), dev: i32) {
        let window = &surface.window;
        let logical = (layout.window_width / dev, layout.window_height / dev);
        // Same distance from the work area bottom as on Windows: the shape sits
        // one shadow margin above the window bottom.
        let margin = ((BOTTOM_OFFSET - SHADOW_MARGIN) * user_scale()).round() as i32;

        if surface.window_size != logical {
            window.set_size_request(logical.0, logical.1);
            window.resize(logical.0, logical.1);
            surface.window_size = logical;
            if !surface.layer {
                place_fallback(window, logical, margin);
            }
        }
        if surface.margin != margin {
            surface.margin = margin;
            if surface.layer {
                window.set_layer_shell_margin(gtk_layer_shell::Edge::Bottom, margin);
            } else {
                place_fallback(window, logical, margin);
            }
        }

        // Only the resting shape takes clicks; everything around it, the
        // shadow included, lets them through to the window below.
        let margin_px = SHADOW_MARGIN * (dev as f32 * user_scale());
        let shape_x = (layout.window_width as f32 - rest.0) / 2.0;
        let shape_y = layout.window_height as f32 - margin_px - rest.1;
        let d = dev as f32;
        let rect = (
            (shape_x / d).floor() as i32,
            (shape_y / d).floor() as i32,
            (rest.0 / d).ceil() as i32,
            (rest.1 / d).ceil() as i32,
        );
        if surface.input_rect != Some(rect) {
            surface.input_rect = Some(rect);
            let region = cairo::Region::create_rectangle(&cairo::RectangleInt::new(
                rect.0, rect.1, rect.2, rect.3,
            ));
            window.input_shape_combine_region(Some(&region));
        }
    }

    /// Without layer-shell: bottom center of the primary monitor's work area.
    /// Wayland compositors ignore this; X11 honors it.
    fn place_fallback(window: &gtk::Window, logical: (i32, i32), margin: i32) {
        let Some(display) = gdk::Display::default() else {
            return;
        };
        let Some(monitor) = display.primary_monitor().or_else(|| display.monitor(0)) else {
            return;
        };
        let area = monitor.workarea();
        window.move_(
            area.x() + (area.width() - logical.0) / 2,
            area.y() + area.height() - margin - logical.1,
        );
    }

    fn draw_text(
        window: &gtk::Window,
        frame: &cairo::ImageSurface,
        layout: &Layout,
        text: &str,
        is_error: bool,
        total_height: f32,
        scale: f32,
    ) {
        let Ok(cr) = cairo::Context::new(frame) else {
            return;
        };
        // ATOP keeps the glass alpha, like the Windows path that restores the
        // alpha channel after GDI drew the text.
        cr.set_operator(cairo::Operator::Atop);
        let text_layout = text_layout(window, text, scale);
        let attributes = pango::AttrList::new();
        attributes.insert(pango::AttrColor::new_foreground(65535, 65535, 65535));
        attributes.insert(pango::AttrInt::new_foreground_alpha(
            (TEXT_ALPHA * 65535.0) as u16,
        ));
        text_layout.set_attributes(Some(&attributes));
        let style = window.style_context();

        if is_error {
            let inset = TEXT_PADDING * scale;
            let width = layout.shape_width - 2.0 * inset;
            text_layout.set_single_paragraph_mode(true);
            text_layout.set_width((width * pango::SCALE as f32) as i32);
            text_layout.set_ellipsize(pango::EllipsizeMode::End);
            text_layout.set_alignment(pango::Alignment::Center);
            let (_, height) = text_layout.pixel_size();
            let y = layout.shape_y + (layout.shape_height - height as f32) / 2.0;
            gtk::render_layout(
                &style,
                &cr,
                (layout.shape_x + inset).round() as f64,
                y.round() as f64,
                &text_layout,
            );
        } else if let Some((tx, ty, tw, th)) = layout.text_area {
            // Older lines scroll out of view at the top.
            let overflow = (total_height - th).max(0.0);
            cr.rectangle(
                tx.floor() as f64,
                ty.floor() as f64,
                tw.ceil() as f64,
                th.ceil() as f64,
            );
            cr.clip();
            text_layout.set_width((tw * pango::SCALE as f32) as i32);
            text_layout.set_wrap(pango::WrapMode::WordChar);
            gtk::render_layout(
                &style,
                &cr,
                tx.floor() as f64,
                (ty - overflow).floor() as f64,
                &text_layout,
            );
        }
        drop(cr);
        frame.flush();
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::AtomicUsize;

        static CANCELS: AtomicUsize = AtomicUsize::new(0);
        static CONFIRMS: AtomicUsize = AtomicUsize::new(0);

        fn pump_for(ms: u64) {
            let until = std::time::Instant::now() + Duration::from_millis(ms);
            while std::time::Instant::now() < until {
                while gtk::events_pending() {
                    gtk::main_iteration_do(false);
                }
                std::thread::sleep(Duration::from_millis(4));
            }
        }

        fn show(state: PillState) {
            *state_cell().lock().unwrap() = state;
            apply_state();
        }

        /// Synthesizes a left click at a point given in frame pixels.
        fn click_frame_point(x: f32, y: f32) {
            let window = window().unwrap();
            let (origin_x, origin_y) =
                SURFACE.with(|cell| frame_origin(&window, cell.borrow().as_ref().unwrap()));
            let dev = window.scale_factor().max(1) as f64;
            let mut event = gdk::Event::new(gdk::EventType::ButtonPress);
            unsafe {
                let raw = event.as_mut() as *mut gdk::ffi::GdkEventAny as *mut gdk::ffi::GdkEventButton;
                (*raw).button = 1;
                (*raw).x = (x as f64 + origin_x) / dev;
                (*raw).y = (y as f64 + origin_y) / dev;
            }
            let button = event.downcast_ref::<gdk::EventButton>().unwrap();
            on_button_press(&window, button);
        }

        fn screenshot(name: &str) {
            let directory = std::env::var("SPECHY_PILL_SHOTS")
                .unwrap_or_else(|_| "/tmp/claude-1000/spechy-pill".to_string());
            let _ = std::fs::create_dir_all(&directory);
            let display = gdk::Display::default().unwrap();
            let monitor = display.primary_monitor().or_else(|| display.monitor(0)).unwrap();
            let area = monitor.geometry();
            let (width, height) = (560, 300);
            let geometry = format!(
                "{},{} {}x{}",
                area.x() + (area.width() - width) / 2,
                area.y() + area.height() - height,
                width,
                height
            );
            let path = format!("{directory}/{name}.png");
            match std::process::Command::new("grim")
                .args(["-g", &geometry, &path])
                .status()
            {
                Ok(status) if status.success() => println!("screenshot {path}"),
                other => println!("grim failed for {name}: {other:?}"),
            }
        }

        #[test]
        #[ignore = "Opens the pill on the desktop (no microphone, no sound); grim screenshots"]
        fn pill_linux_states_and_clicks() {
            gtk::init().unwrap();
            STARTED.store(true, Ordering::SeqCst);
            start(
                Box::new(|| {
                    CANCELS.fetch_add(1, Ordering::SeqCst);
                }),
                Box::new(|| {
                    CONFIRMS.fetch_add(1, Ordering::SeqCst);
                }),
            )
            .unwrap();
            println!("layer shell: {}", layer_shell_supported());

            show(PillState::Idle);
            pump_for(500);
            screenshot("1-idle");

            show(PillState::Recording { level: 0.6, live_text: String::new() });
            pump_for(500);
            assert!(window().unwrap().is_visible());
            screenshot("2-recording");

            // The cancel and confirm buttons react to clicks at their centers.
            let areas = *hit_areas().lock().unwrap();
            assert!(areas.active, "recording must expose the buttons");
            click_frame_point(areas.cancel.0, areas.cancel.1);
            click_frame_point(areas.confirm.0, areas.confirm.1);
            // Between the buttons nothing happens.
            click_frame_point(
                (areas.cancel.0 + areas.confirm.0) / 2.0,
                areas.cancel.1,
            );
            pump_for(100);
            assert_eq!(CANCELS.load(Ordering::SeqCst), 1);
            assert_eq!(CONFIRMS.load(Ordering::SeqCst), 1);

            // Live transcript: the pill grows upward, older lines scroll away.
            set_state_test(PillState::Recording {
                level: 0.4,
                live_text: "Das ist ein kurzer Test des Live-Transkripts.".into(),
            });
            pump_for(500);
            screenshot("3-live-short");
            set_state_test(PillState::Recording {
                level: 0.4,
                live_text: "Das ist ein deutlich laengerer Test des Live-Transkripts, \
                    der ueber mehrere Zeilen laeuft, damit man sieht, wie die Pill nach oben \
                    waechst und aeltere Zeilen oben aus dem sichtbaren Bereich verschwinden. \
                    Noch ein Satz. Und noch einer, damit es wirklich mehr als fuenf Zeilen \
                    werden und das Scrollen greift."
                    .into(),
            });
            pump_for(500);
            screenshot("4-live-long");

            show(PillState::Processing);
            pump_for(500);
            screenshot("5-processing");

            let retried = std::sync::Arc::new(AtomicBool::new(false));
            let flag = retried.clone();
            set_retry_handler(move || flag.store(true, Ordering::SeqCst));
            show(PillState::Error { message: "Click to retry".into(), retry: true });
            pump_for(500);
            screenshot("6-error-retry");
            click_frame_point(10.0, 10.0);
            pump_for(100);
            assert!(retried.load(Ordering::SeqCst), "retry click must call the handler");

            show(PillState::Done);
            pump_for(150);
            screenshot("7-done");
            // Done hides itself after 600 ms plus the hide transition.
            pump_for(900);
            assert!(!window().unwrap().is_visible(), "done must hide the pill");
            assert!(matches!(current_state(), PillState::Hidden));
            assert!(TICK.with(|cell| cell.borrow().is_none()), "tick must stop when hidden");
        }

        /// Renders every state without showing a window and writes the raw
        /// premultiplied BGRA frames as `<name>_<width>x<height>.bgra`, so the
        /// look can be checked without touching the desktop.
        #[test]
        #[ignore = "Needs a display connection; writes raw frames to SPECHY_PILL_SHOTS"]
        fn pill_linux_offscreen_frames() {
            gtk::init().unwrap();
            create_window().unwrap();
            let directory = std::env::var("SPECHY_PILL_SHOTS")
                .unwrap_or_else(|_| "/tmp/claude-1000/spechy-pill".to_string());
            std::fs::create_dir_all(&directory).unwrap();
            let long = "Das ist ein deutlich laengerer Test des Live-Transkripts, der ueber \
                mehrere Zeilen laeuft, damit man sieht, wie die Pill nach oben waechst und \
                aeltere Zeilen oben aus dem sichtbaren Bereich verschwinden. Noch ein Satz. \
                Und noch einer, damit es wirklich mehr als fuenf Zeilen werden.";
            let cases: Vec<(&str, PillState, Motion, f32)> = vec![
                ("idle", PillState::Idle, Motion::None, 1.0),
                (
                    "recording",
                    PillState::Recording { level: 0.7, live_text: String::new() },
                    Motion::None,
                    1.0,
                ),
                (
                    "recording-show-40",
                    PillState::Recording { level: 0.7, live_text: String::new() },
                    Motion::Show,
                    0.4,
                ),
                (
                    "live-short",
                    PillState::Recording { level: 0.3, live_text: "Hallo, kurzer Test.".into() },
                    Motion::None,
                    1.0,
                ),
                (
                    "live-long",
                    PillState::Recording { level: 0.3, live_text: long.into() },
                    Motion::None,
                    1.0,
                ),
                ("processing", PillState::Processing, Motion::None, 1.0),
                (
                    "error-retry",
                    PillState::Error { message: "Click to retry".into(), retry: true },
                    Motion::None,
                    1.0,
                ),
                (
                    "error-long",
                    PillState::Error {
                        message: "Transcription failed: the provider did not answer in time, \
                            check your connection and the API key"
                            .into(),
                        retry: false,
                    },
                    Motion::None,
                    1.0,
                ),
                ("done", PillState::Done, Motion::None, 1.0),
            ];
            for (name, state, motion, progress) in cases {
                *state_cell().lock().unwrap() = state.clone();
                ANIM.with(|cell| {
                    let mut anim = cell.borrow_mut();
                    anim.visible = true;
                    anim.visible_state = state.clone();
                    // No previous shape: never start a resize here.
                    anim.last_shape = None;
                    anim.begin(motion, progress);
                    if motion == Motion::None {
                        anim.motion = Motion::None;
                    }
                });
                FRAME.store(20, Ordering::Relaxed);
                SURFACE.with(|cell| {
                    let mut slot = cell.borrow_mut();
                    let surface = slot.as_mut().unwrap();
                    paint(surface, &state, motion, progress);
                    let mut frame = surface.frame.take().unwrap();
                    let (width, height) = (surface.width, surface.height);
                    with_pixels(&mut frame, |pixels| {
                        let path = format!("{directory}/{name}_{width}x{height}.bgra");
                        std::fs::write(&path, &pixels[..]).unwrap();
                        println!("{path}");
                    });
                    surface.frame = Some(frame);
                });
            }
        }

        /// Like the public set_state: the tick picks up text changes.
        fn set_state_test(state: PillState) {
            set_state(state);
        }
    }
}

// ------------------------------------------------------------------ API

#[cfg(windows)]
pub fn init(
    on_cancel: impl Fn() + Send + 'static,
    on_confirm: impl Fn() + Send + 'static,
) -> Result<(), String> {
    if STARTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    // Start out at the size the user configured, so the first show is right.
    let percent = crate::settings::current().pill_scale;
    USER_SCALE.store(
        percent.clamp(MIN_SCALE_PERCENT, MAX_SCALE_PERCENT),
        Ordering::SeqCst,
    );
    win::make_dpi_aware();
    win::start(Box::new(on_cancel), Box::new(on_confirm))
}

#[cfg(windows)]
pub fn set_state(state: PillState) {
    let kind = kind_of(&state);
    let mut changed = true;
    if let Ok(mut guard) = state_cell().lock() {
        changed = kind_of(&guard) != kind;
        *guard = state;
    }
    // Level and live-text updates arrive about 20 times per second. They only
    // update the shared state; the 16 ms animation timer picks them up. A window
    // message is posted when the kind changes, or when nothing animates and the
    // repaint would otherwise never happen.
    if changed || !kind_animates(kind) {
        win::notify();
    }
}

/// Re-layout and repaint right away, also while the pill is on screen.
#[cfg(windows)]
fn repaint() {
    win::notify();
}

#[cfg(target_os = "linux")]
pub fn init(
    on_cancel: impl Fn() + Send + 'static,
    on_confirm: impl Fn() + Send + 'static,
) -> Result<(), String> {
    if STARTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let percent = crate::settings::current().pill_scale;
    USER_SCALE.store(
        percent.clamp(MIN_SCALE_PERCENT, MAX_SCALE_PERCENT),
        Ordering::SeqCst,
    );
    let result = linux::start(Box::new(on_cancel), Box::new(on_confirm));
    if result.is_err() {
        STARTED.store(false, Ordering::SeqCst);
    }
    result
}

#[cfg(target_os = "linux")]
pub fn set_state(state: PillState) {
    let kind = kind_of(&state);
    let mut changed = true;
    if let Ok(mut guard) = state_cell().lock() {
        changed = kind_of(&guard) != kind;
        *guard = state;
    }
    // Same throttling as on Windows: level and live-text updates ride along
    // with the animation tick; only a kind change schedules a main-loop update.
    if changed || !kind_animates(kind) {
        linux::notify();
    }
}

#[cfg(target_os = "linux")]
fn repaint() {
    linux::notify();
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn init(
    _on_cancel: impl Fn() + Send + 'static,
    _on_confirm: impl Fn() + Send + 'static,
) -> Result<(), String> {
    Err("The pill is only implemented on Windows and Linux.".to_string())
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn set_state(state: PillState) {
    if let Ok(mut guard) = state_cell().lock() {
        *guard = state;
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
fn repaint() {}
