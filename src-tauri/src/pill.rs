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

// ------------------------------------------------------------------ globals

struct Callbacks {
    cancel: Box<dyn Fn() + Send>,
    confirm: Box<dyn Fn() + Send>,
}

static CALLBACKS: OnceLock<Mutex<Callbacks>> = OnceLock::new();
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
    fn glass_rim(
        &mut self,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        radius: f32,
        thickness: f32,
    ) {
        let half = thickness / 2.0;
        self.fill_shaded(
            (
                x - thickness,
                y - thickness,
                x + width + thickness,
                y + height + thickness,
            ),
            move |px, py| {
                rounded_rect_distance(px, py, x, y, width, height, radius).abs() - half
            },
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

    if matches!(state, PillState::Idle | PillState::Error { .. } | PillState::Hidden) {
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
        canvas.circle(dot_x, middle, dot_radius, WHITE, alpha);
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
        AC_SRC_ALPHA, AC_SRC_OVER, ANTIALIASED_QUALITY, BITMAPINFO, BITMAPINFOHEADER,
        BLENDFUNCTION, BI_RGB, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DIB_RGB_COLORS, DT_CALCRECT,
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

    /// Text is drawn into a premultiplied buffer, so its color has to be
    /// multiplied by the glass alpha and the text alpha up front.
    const TEXT_ALPHA: f32 = 0.92;

    pub fn start(cancel: Box<dyn Fn() + Send>, confirm: Box<dyn Fn() + Send>) -> Result<(), String> {
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
            let _ = ShowWindow(hwnd, SW_HIDE);
            return;
        }

        render(hwnd);
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
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
            let _ = ShowWindow(hwnd, SW_HIDE);
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
            PillState::Error { message } => message.clone(),
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
                log::debug!(
                    "pill: resize to {:.0}x{:.0}",
                    rest.0,
                    rest.1
                );
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
                surface
                    .alpha_scratch
                    .extend((3..surface.byte_count).step_by(4).map(|i| *surface.bits.add(i)));
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

#[cfg(not(windows))]
pub fn init(
    _on_cancel: impl Fn() + Send + 'static,
    _on_confirm: impl Fn() + Send + 'static,
) -> Result<(), String> {
    Err("The pill is only implemented on Windows.".to_string())
}

#[cfg(not(windows))]
pub fn set_state(state: PillState) {
    if let Ok(mut guard) = state_cell().lock() {
        *guard = state;
    }
}

#[cfg(not(windows))]
fn repaint() {}
