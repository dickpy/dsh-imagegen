/**
 * Deterministic recovery of the non-text visual layer of a slide.
 *
 * Why this exists: the model abstains on image-heavy pages (a real postmortem
 * produced `text_boxes=5, shapes=0, images=0` on a page whose non-text ink is
 * 49% of the canvas), and pixel geometry is measurable anyway — so panels, lines
 * and bitmap regions are measured here, and the model is left with what it is
 * actually good at (reading text, naming regions).
 *
 * The analysis runs in the venv's own Python (numpy + Pillow are already CLI
 * dependencies). It is a pure measurement: same pixels, same JSON.
 */

/** One measured non-text region, in source-pixel coordinates. */
export interface VisualRegion {
  box: [number, number, number, number]
  areaPct: number
  /** Share of the page the bounding box covers (full-bleed test). */
  boxPct: number
  /** `color_spread`: mean per-channel std of this palette colour's pixels. */
  spread: number
  fill: number
  /** Share of OCR text boxes inside the bbox, at half resolution. */
  textShare: number
  kind: 'panel' | 'line' | 'bitmap'
  /** Median colour of the region, `#RRGGBB`. */
  color: string
  /** Palette index, kept so a run's log can be replayed against the probe. */
  paletteIndex?: number
}

/** Result of one `analyze` pass over a page. */
export interface VisualAnalysis {
  background: string
  /** Border-mode background as RGB triple, kept for the fidelity report. */
  backgroundRgb: [number, number, number]
  inkPct: number
  nonTextInkPct: number
  regions: VisualRegion[]
}

export interface FidelityReport {
  fidelity: number
  sourceInkPct: number
  previewInkPct: number
}

const HEX = /^#[0-9A-Fa-f]{6}$/

function toHex(triple: unknown): string | undefined {
  if (!Array.isArray(triple) || triple.length < 3) return undefined
  const parts = triple.slice(0, 3).map(value => Math.round(Number(value)))
  if (parts.some(value => !Number.isFinite(value))) return undefined
  return `#${parts.map(value => value.toString(16).padStart(2, '0').toUpperCase()).join('')}`
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Parse the analyzer's stdout JSON. Anything unusable is dropped rather than
 * guessed: a bad box would land a shape in the wrong place, and `page validate`
 * cannot tell that a region is missing.
 */
export function parseVisualAnalysis(raw: unknown): VisualAnalysis | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const entries = Array.isArray(value.regions) ? value.regions : []
  const regions: VisualRegion[] = []
  for (const entry of entries) {
    // Each region is an object (the analyzer's `areas` records), not a tuple.
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const item = entry as Record<string, unknown>
    const box = item.box
    if (!Array.isArray(box) || box.length < 4) continue
    const [x, y, w, h] = box.map(part => Math.round(Number(part)))
    if ([x, y, w, h].some(part => !Number.isFinite(part)) || w < 8 || h < 8) continue
    const kind = item.kind === 'panel' || item.kind === 'line' || item.kind === 'bitmap' ? item.kind : 'bitmap'
    const color = toHex(item.color) ?? toHex(item.mode_color)
    if (color === undefined) continue
    const index = numberOr(item.index, NaN)
    regions.push({
      box: [x, y, w, h],
      areaPct: numberOr(item.area_pct, 0),
      boxPct: numberOr(item.box_pct, 0),
      spread: numberOr(item.spread, numberOr(item.variance, 0)),
      fill: numberOr(item.fill, 0),
      textShare: numberOr(item.text_share, 0),
      kind,
      color,
      ...(Number.isFinite(index) ? { paletteIndex: index } : {}),
    })
  }
  const backgroundRgbRaw = value.background
  const backgroundRgb = Array.isArray(backgroundRgbRaw) && backgroundRgbRaw.length >= 3
    ? [Math.round(Number(backgroundRgbRaw[0])), Math.round(Number(backgroundRgbRaw[1])), Math.round(Number(backgroundRgbRaw[2]))] as [number, number, number]
    : [255, 255, 255] as [number, number, number]
  const background = toHex(backgroundRgb) ?? '#FFFFFF'
  if (!HEX.test(background)) return undefined
  return {
    background,
    backgroundRgb,
    inkPct: numberOr(value.ink_pct, 0),
    nonTextInkPct: numberOr(value.non_text_ink_pct, 0),
    regions,
  }
}

function clampPositive(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/** Ratio of a region's area to the page area. */
export function regionAreaRatio(region: VisualRegion, width: number, height: number): number {
  const page = width * height
  if (page <= 0) return 0
  return (region.box[2] * region.box[3]) / page
}

/**
 * A region whose bounding box covers essentially the whole canvas cannot be a
 * placed bitmap: as a crop it is banned upstream (full-slide raster behind
 * editable text), and as a clean base it is the only shape the pipeline may take
 * to an image backend.
 */
export function isFullBleed(region: VisualRegion, width: number, height: number, threshold = 0.85): boolean {
  const measured = region.boxPct > 0 ? region.boxPct / 100 : regionAreaRatio(region, width, height)
  return measured >= threshold
}

/** Centres of the measured text lines, used to keep text out of bitmap regions. */
export function pointInside(box: readonly number[], x: number, y: number, slack = 0): boolean {
  return x >= box[0] - slack && x <= box[0] + box[2] + slack && y >= box[1] - slack && y <= box[1] + box[3] + slack
}

/**
 * Manifest shape for a measured panel.
 *
 * Straight corners: the palette pass cannot measure a corner radius reliably, and
 * a `roundRect` without `source_corner_radius_px` is a contract violation, so a
 * measured panel is always an honest `rect` with its median fill colour.
 */
export function panelShape(region: VisualRegion, id: string): Record<string, unknown> {
  return {
    id,
    type: 'rect',
    box_px: region.box,
    fill: region.color.slice(1),
    stroke: 'none',
    corner_category: 'straight',
    z_index: 100,
  }
}

/** Manifest shape for a measured thin bar (native line, axis-aligned). */
export function lineShape(region: VisualRegion, id: string, semantic: string): Record<string, unknown> | undefined {
  const [x, y, w, h] = region.box
  const stroke = region.color.slice(1)
  if (w >= h) {
    const mid = Math.round(y + h / 2)
    return {
      id,
      type: 'line',
      points_px: [x, mid, x + w, mid],
      fill: 'none',
      stroke,
      stroke_width: clampPositive(h, 0.5, 12),
      start_arrow: 'none',
      end_arrow: 'none',
      semantic_line_id: `${semantic}-h`,
      z_index: 110,
    }
  }
  const mid = Math.round(x + w / 2)
  return {
    id,
    type: 'line',
    points_px: [mid, y, mid, y + h],
    fill: 'none',
    stroke,
    stroke_width: clampPositive(w, 0.5, 12),
    start_arrow: 'none',
    end_arrow: 'none',
    semantic_line_id: `${semantic}-v`,
    z_index: 110,
  }
}

export function parseFidelityReport(raw: unknown): FidelityReport | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const fidelity = value.fidelity
  if (typeof fidelity !== 'number' || !Number.isFinite(fidelity)) return undefined
  return {
    fidelity: Math.round(clampPositive(fidelity, 0, 9.999) * 1000) / 1000,
    sourceInkPct: numberOr(value.source_ink_pct, 0),
    previewInkPct: numberOr(value.preview_ink_pct, 0),
  }
}

/**
 * The analyzer, ported from the validated probe (`output/postmortem/probe_quant.py`).
 *
 * Two modes:
 *
 *  - `analyze <source.png> <text_hints.json> [colors]` → background + region list
 *  - `fidelity <source.png> <text_hints.json> <boxesJson>` → share of the source's
 *    non-text ink that our rebuilt object boxes actually cover
 *
 * Why palette quantization and not ink thresholding (both were tried on the real
 * postmortem page): a threshold merges card borders with their anti-aliased text
 * into one blob at 24, and turns 81% of the page into a single region at 12 — the
 * failure that produced a text-only deck. Connected area of one *non-background
 * palette colour* instead yields filled rectangles with a single median colour for
 * cards and pills, while an illustration page collapses into one giant multi-colour
 * area, which is exactly the signal that the page needs a clean base.
 *
 * Cost: the page is halved first, so components run over ~0.4 megapixels.
 */
export const VISUAL_REGION_SCRIPT = `import sys, json
from collections import Counter, deque
import numpy as np
from PIL import Image

def quantize(src_path, colors):
    im = Image.open(src_path).convert('RGB')
    w, h = im.size
    small = im.resize((max(1, w // 2), max(1, h // 2)), Image.LANCZOS)
    q = small.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE)
    lab = np.asarray(q, dtype=np.int32)
    return im, w, h, lab, np.asarray(small, np.int16)

def hint_boxes(hints_path):
    try:
        hints = json.loads(open(hints_path, encoding='utf-8').read())
    except Exception:
        return []
    out = []
    for line in hints.get('lines') or []:
        box = line.get('box_px')
        if box and len(box) >= 4:
            out.append([float(v) for v in box[:4]])
    return out

def analyze(src_path, hints_path, colors):
    im, w, h, lab, rgb = quantize(src_path, colors)
    sh, sw = lab.shape
    boxes = hint_boxes(hints_path)
    text_mask = np.zeros((sh, sw), bool)
    for x, y, bw, bh in boxes:
        text_mask[max(0, int(y // 2) - 5):min(sh, int((y + bh) // 2) + 5),
                  max(0, int(x // 2) - 5):min(sw, int((x + bw) // 2) + 5)] = True
    border = np.concatenate([lab[:3].ravel(), lab[-3:].ravel(), lab[:, :3].ravel(), lab[:, -3:].ravel()])
    bg_index = int(Counter(border.tolist()).most_common(1)[0][0])
    bg_rgb = np.median(rgb[lab == bg_index], axis=0) if (lab == bg_index).any() else np.array([255, 255, 255])
    min_pixels = 0.004 * sw * sh
    regions = []
    for index in np.unique(lab):
        if int(index) == bg_index:
            continue
        mask = lab == index
        if int(mask.sum()) < min_pixels:
            continue
        seen = np.zeros(mask.shape, bool)
        for y0, x0 in np.argwhere(mask):
            if seen[y0, x0]:
                continue
            queue = deque([(int(y0), int(x0))])
            seen[y0, x0] = True
            count = 0
            mini = maxi = int(y0)
            minj = majj = int(x0)
            while queue:
                y, x = queue.popleft()
                count += 1
                if y < mini: mini = y
                if y > maxi: maxi = y
                if x < minj: minj = x
                if x > majj: majj = x
                for ny, nx in ((y - 1, x), (y + 1, x), (y - 1, x - 1), (y - 1, x + 1), (y, x - 1), (y, x + 1), (y + 1, x - 1), (y + 1, x + 1)):
                    if 0 <= ny < sh and 0 <= nx < sw and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        queue.append((ny, nx))
            if count < min_pixels:
                continue
            bw = (majj - minj + 1) * 2
            bh = (maxi - mini + 1) * 2
            if bw < 28 or bh < 28:
                continue
            sub = mask[mini:maxi + 1, minj:majj + 1]
            cell = rgb[mini:maxi + 1, minj:majj + 1]
            fill = float(sub.mean())
            spread = float(cell[sub].std(axis=0).mean()) if sub.any() else 0.0
            color = [int(v) for v in np.median(cell[sub], axis=0)] if sub.any() else [255, 255, 255]
            text_share = float(text_mask[mini:maxi + 1, minj:majj + 1].mean())
            # Classification rules measured on the real pages: cards sit at
            # spread 0.8-2.2, a header band 0.5, a pill 6.8 with text_share 0.52 —
            # all panels; the photo block measured spread 9.1 with no text → bitmap.
            if min(bw, bh) < 30:
                kind = 'line'
            elif text_share > 0.4 or spread < 8:
                kind = 'panel'
            else:
                kind = 'bitmap'
            regions.append({
                'box': [int(minj * 2), int(mini * 2), int(bw), int(bh)],
                'index': int(index),
                'area_pct': round(count * 4 / (w * h) * 100, 2),
                'box_pct': round(bw * bh / (w * h) * 100, 2),
                'fill': round(fill, 2),
                'spread': round(spread, 1),
                'text_share': round(text_share, 2),
                'kind': kind,
                'color': color,
                'stroke': None,
                'stroke_width': None,
                'corner_radius': 0,
            })
    regions.sort(key=lambda r: -r['area_pct'])
    return {'width': int(w), 'height': int(h), 'background': [int(v) for v in bg_rgb],
            'bg_index': bg_index, 'colors': int(colors),
            'ink_pct': round(float((lab != bg_index).mean()) * 100, 2),
            'non_text_ink_pct': round(float(((lab != bg_index) & ~text_mask).mean()) * 100, 2),
            'regions': regions}

def fidelity(src_path, hints_path, boxes_json):
    im, w, h, lab, rgb = quantize(src_path, 12)
    sh, sw = lab.shape
    border = np.concatenate([lab[:3].ravel(), lab[-3:].ravel(), lab[:, :3].ravel(), lab[:, -3:].ravel()])
    bg_index = int(Counter(border.tolist()).most_common(1)[0][0])
    text_mask = np.zeros((sh, sw), bool)
    for x, y, bw, bh in hint_boxes(hints_path):
        text_mask[max(0, int(y // 2) - 5):min(sh, int((y + bh) // 2) + 5),
                  max(0, int(x // 2) - 5):min(sw, int((x + bw) // 2) + 5)] = True
    boxes = json.loads(boxes_json)
    covered = np.zeros((sh, sw), bool)
    for box in boxes:
        x, y, bw, bh = [int(v) for v in box[:4]]
        covered[max(0, y // 2):min(sh, (y + bh) // 2), max(0, x // 2):min(sw, (x + bw) // 2)] = True
    # Quarter resolution: the metric is a share of the *non-text* ink the rebuilt
    # object boxes cover, so typography never inflates it into a pass.
    quarter = lab[::2, ::2] != bg_index
    qtext = text_mask[::2, ::2]
    qcovered = covered[::2, ::2]
    ink = quarter & ~qtext
    total = int(ink.sum())
    hits = int((ink & qcovered).sum())
    share = 0.0 if total == 0 else round(hits / total, 3)
    return {'fidelity': share, 'source_ink_pct': round(float(ink.mean()) * 100, 2),
            'preview_ink_pct': round(float((ink & qcovered).mean()) * 100, 2),
            'boxes': len(boxes)}

def main():
    mode = sys.argv[1]
    if mode == 'analyze':
        colors = int(sys.argv[4]) if len(sys.argv) > 4 else 12
        print(json.dumps(analyze(sys.argv[2], sys.argv[3], colors)))
        return 0
    if mode == 'fidelity':
        print(json.dumps(fidelity(sys.argv[2], sys.argv[3], sys.argv[4])))
        return 0
    raise SystemExit('unknown mode: %s' % mode)

if __name__ == '__main__':
    sys.exit(main())
`

/** Command lines for the two analyzer modes (run through the venv's Python). */
export function analyzeArgs(python: string, source: string, hints: string): string[] {
  return [python, '-c', VISUAL_REGION_SCRIPT, 'analyze', source, hints]
}

export function fidelityArgs(python: string, source: string, hints: string, boxes: string): string[] {
  return [python, '-c', VISUAL_REGION_SCRIPT, 'fidelity', source, hints, boxes]
}

/** First JSON object on a stdout line (the analyzer prints exactly one). */
export function firstJsonObject(output: string): unknown {
  const line = output.trim().split(/\r?\n/).reverse().find(entry => entry.trim().startsWith('{'))
  if (line === undefined) return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
