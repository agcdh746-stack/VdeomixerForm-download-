'use strict';

// =====================================================================
// Title pre-renderer v2.5 — Pillow + libraqm + harfbuzz + fribidi
//
// IMPROVEMENTS in v2.5:
//   - Aggressive auto font-size shrinking (1px steps)
//   - Pixel-precise word wrap (not char count)
//   - Larger safety padding (text never touches edges)
//   - Verifies actual rendered height vs canvas height
//   - 5-line max for very long titles
// =====================================================================

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const FONT_DIR = path.join(__dirname, '..', 'public', 'fonts');

const PY_RENDERER = `
import sys, json, unicodedata
from PIL import Image, ImageDraw, ImageFont

cfg = json.loads(sys.argv[1])
W = cfg['width']; H = cfg['height']
font_path = cfg['font_path']
emoji_font_path = cfg.get('emoji_font_path', None)
raw_text = cfg['text'].strip() or ' '
fg = tuple(cfg.get('fg', [255,255,255,255]))
bg = tuple(cfg.get('bg', [0,0,0,0]))
shadow = cfg.get('shadow', None)
accent_color_raw = cfg.get('accent_color', None)
accent_color = tuple(accent_color_raw) if accent_color_raw else None

# Split for two‑tone
if '|' in raw_text and accent_color:
    parts = raw_text.split('|', 1)
    part1_text = parts[0].strip()
    part2_text = parts[1].strip()
    words_all = (part1_text + ' ' + part2_text).split()
else:
    part1_text = raw_text
    part2_text = None
    words_all = raw_text.split()

target_font_size = cfg['font_size']
min_font_size = cfg.get('min_font_size', 18)
align = cfg.get('align', 'center')
out_path = cfg['out']
padding_x = cfg.get('padding_x', 30)
padding_y = cfg.get('padding_y', 20)
max_lines = cfg.get('max_lines', 5)
line_height_ratio = cfg.get('line_height_ratio', 1.30)

def _detect_layout(fp):
    basic = ImageFont.Layout.BASIC if hasattr(ImageFont, 'Layout') else (ImageFont.LAYOUT_BASIC if hasattr(ImageFont, 'LAYOUT_BASIC') else 0)
    raqm  = ImageFont.Layout.RAQM  if hasattr(ImageFont, 'Layout') else (ImageFont.LAYOUT_RAQM  if hasattr(ImageFont, 'LAYOUT_RAQM')  else None)
    if raqm is None:
        return basic
    try:
        f = ImageFont.truetype(fp, 20, layout_engine=raqm)
        tmp = Image.new('RGBA', (200, 40))
        d   = ImageDraw.Draw(tmp)
        bb  = d.textbbox((0, 0), '\u09ac\u09be\u0982\u09b2\u09be', font=f)
        if bb[2] - bb[0] < 120:
            return raqm
        return basic
    except:
        return basic

layout = _detect_layout(font_path)
emoji_layout = ImageFont.Layout.BASIC if hasattr(ImageFont, 'Layout') else (ImageFont.LAYOUT_BASIC if hasattr(ImageFont, 'LAYOUT_BASIC') else 0)

def wrap_by_pixel(words, font, max_w, draw):
    lines = []
    cur = []
    for w in words:
        candidate = ' '.join(cur + [w])
        bbox = draw.textbbox((0, 0), candidate, font=font)
        if bbox[2] - bbox[0] <= max_w or not cur:
            cur.append(w)
        else:
            lines.append(' '.join(cur))
            cur = [w]
    if cur:
        lines.append(' '.join(cur))
    return lines

def measure(font_size):
    font = ImageFont.truetype(font_path, font_size, layout_engine=layout)
    tmp = Image.new('RGBA', (10, 10))
    draw = ImageDraw.Draw(tmp)
    max_w = W - 2 * padding_x

    if part2_text:
        lines_p1 = wrap_by_pixel(part1_text.split(), font, max_w, draw) if part1_text else []
        lines_p2 = wrap_by_pixel(part2_text.split(), font, max_w, draw) if part2_text else []
        lines = lines_p1 + lines_p2
    else:
        lines = wrap_by_pixel(words_all, font, max_w, draw)

    line_h = int(font_size * line_height_ratio)
    total_h = line_h * len(lines)
    max_line_w = 0
    max_descent = 0
    for ln in lines:
        bb = draw.textbbox((0, 0), ln, font=font)
        max_line_w = max(max_line_w, bb[2] - bb[0])
        max_descent = max(max_descent, bb[3])
    total_h_real = total_h + max_descent // 4
    return font, lines, line_h, total_h_real, max_line_w

# Auto‑shrink
font_size = target_font_size
final = None
while font_size >= min_font_size:
    font, lines, line_h, total_h, max_line_w = measure(font_size)
    if (total_h <= H - 2 * padding_y and
        max_line_w <= W - 2 * padding_x and
        len(lines) <= max_lines):
        final = (font, lines, line_h, total_h, font_size)
        break
    font_size -= 1

if final is None:
    font_size = min_font_size
    font, lines, line_h, total_h, _ = measure(font_size)
    final = (font, lines, line_h, total_h, font_size)

font, lines, line_h, total_h, used_size = final

img = Image.new('RGBA', (W, H), bg)
draw = ImageDraw.Draw(img)

y_start = max(padding_y, (H - total_h) // 2)

# ──────────────── Emoji rendering ────────────────────────────
def is_emoji(ch):
    try:
        cat = unicodedata.category(ch)
        cp = ord(ch)
        return cat in ('So', 'Sm') or (0x1F000 <= cp <= 0x1FFFF) or (0x2600 <= cp <= 0x27BF) or cp in (0xFE0F, 0x200D)
    except:
        return False

def render_emoji_to_img(seq, target_h, emoji_font_obj):
    try:
        kwargs = {'embedded_color': True} if hasattr(ImageFont, 'Layout') else {}
        tmp_d = ImageDraw.Draw(Image.new('RGBA',(10,10)))
        bb = tmp_d.textbbox((0,0), seq, font=emoji_font_obj, **kwargs)

        ew = max(1, bb[2]-bb[0])
        eh = max(1, bb[3]-bb[1])
        tmp_e = Image.new('RGBA', (ew + 20, eh + 20), (0,0,0,0))
        de = ImageDraw.Draw(tmp_e)
        de.text((-bb[0]+10, -bb[1]+10), seq, font=emoji_font_obj, **kwargs)

        scale = target_h / max(1, eh)
        new_w = max(1, int(ew * scale))
        new_h = max(1, int(target_h))
        resample = Image.Resampling.LANCZOS if hasattr(Image, 'Resampling') else Image.LANCZOS
        return tmp_e.resize((new_w + 20, new_h + 20), resample), new_w
    except:
        return None, 0

def draw_text_with_emoji(draw, x, y, text, main_font, emoji_font, fill, shadow=None):
    try:
        sample_bb = draw.textbbox((0,0), 'A', font=main_font)
        target_h = max(16, sample_bb[3] - sample_bb[1])
    except:
        target_h = 32

    cx = x
    i = 0
    while i < len(text):
        ch = text[i]
        seq = ch
        j = i + 1
        while j < len(text) and text[j] in ('\uFE0F', '\u200D'):
            seq += text[j]
            j += 1
        if j < len(text) and is_emoji(text[j]) and '\u200D' in seq:
            while j < len(text) and (text[j] in ('\uFE0F', '\u200D') or is_emoji(text[j])):
                seq += text[j]
                j += 1
        use_emoji = emoji_font and any(is_emoji(c) for c in seq)
        if use_emoji:
            emoji_img, ew = render_emoji_to_img(seq, target_h, emoji_font)
            if emoji_img:
                paste_x = int(cx)
                paste_y = int(y - 4)
                if shadow:
                    sr, sg, sb, sa, sox, soy = shadow
                    r, g, b, a_ch = emoji_img.split()
                    shadow_layer = Image.new('RGBA', emoji_img.size, (0,0,0,0))
                    shadow_layer.paste((sr, sg, sb, sa), mask=a_ch)
                    img.paste(shadow_layer, (paste_x + sox, paste_y + soy), shadow_layer)
                img.paste(emoji_img, (paste_x, paste_y), emoji_img)
                cx += ew + 4
                i = j
                continue
        # Regular text
        if shadow:
            sr, sg, sb, sa, sox, soy = shadow
            draw.text((cx + sox, y + soy), seq, font=main_font, fill=(sr, sg, sb, sa))
        draw.text((cx, y), seq, font=main_font, fill=fill)
        bb = draw.textbbox((0, 0), seq, font=main_font)
        cx += bb[2] - bb[0] + 1
        i = j

# Load emoji font
emoji_font = None
if emoji_font_path:
    try:
        emoji_font = ImageFont.truetype(emoji_font_path, font_size, layout_engine=emoji_layout)
    except:
        emoji_font = None

# Colour map based on original part splits
if part2_text:
    tmp_measure = Image.new('RGBA', (10,10))
    tmp_d = ImageDraw.Draw(tmp_measure)
    max_w = W - 2 * padding_x
    lines_p1 = wrap_by_pixel(part1_text.split(), font, max_w, tmp_d) if part1_text else []
    color_map = {}
    for i in range(len(lines)):
        color_map[i] = accent_color if i >= len(lines_p1) else fg
else:
    color_map = {i: fg for i in range(len(lines))}

for i, ln in enumerate(lines):
    bbox = draw.textbbox((0, 0), ln, font=font)
    lw = bbox[2] - bbox[0]
    if align == 'center':
        x = (W - lw) // 2 - bbox[0]
    elif align == 'right':
        x = W - lw - padding_x - bbox[0]
    else:
        x = padding_x - bbox[0]
    y = y_start + i * line_h - bbox[1]
    draw_text_with_emoji(draw, x, y, ln, font, emoji_font, color_map.get(i, fg), shadow)

img.save(out_path)
print('OK', img.size, 'lines=', len(lines), 'final_font=', used_size)
`;