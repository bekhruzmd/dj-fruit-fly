import os
from PIL import Image, ImageEnhance

base_dir = "public/images/ibiza"
img_hi = Image.open(os.path.join(base_dir, "hi_ibiza_lasers.png")).convert("RGB")
img_pano = Image.open(os.path.join(base_dir, "ibiza_panorama.jpg")).convert("RGB")
img_ush = Image.open(os.path.join(base_dir, "ushuaia_stage.png")).convert("RGB")

target_w = 1920
target_h = 1080

def cover_crop(img, w, h):
    ratio = max(w / img.width, h / img.height)
    new_size = (int(img.width * ratio), int(img.height * ratio))
    resized = img.resize(new_size, Image.Resampling.LANCZOS)
    left = (resized.width - w) // 2
    top = (resized.height - h) // 2
    return resized.crop((left, top, left + w, top + h))

panel_w = 680
panel_ush = cover_crop(img_ush, panel_w, target_h)
panel_pano = cover_crop(img_pano, 740, target_h)
panel_hi = cover_crop(img_hi, panel_w, target_h)

composite = Image.new("RGB", (target_w, target_h), (10, 4, 20))
composite.paste(panel_ush, (0, 0))

# Center panel mask
mask_center = Image.new("L", (740, target_h), 255)
for x in range(100):
    a = int((x / 100.0) * 255)
    for y in range(target_h):
        mask_center.putpixel((x, y), a)
for x in range(640, 740):
    a = int(((740 - x) / 100.0) * 255)
    for y in range(target_h):
        mask_center.putpixel((x, y), min(mask_center.getpixel((x, y)), a))

composite.paste(panel_pano, (590, 0), mask_center)

# Right panel mask
mask_hi = Image.new("L", (panel_w, target_h), 255)
for x in range(120):
    a = int((x / 120.0) * 255)
    for y in range(target_h):
        mask_hi.putpixel((x, y), a)

composite.paste(panel_hi, (target_w - panel_w, 0), mask_hi)

enhancer = ImageEnhance.Color(composite)
composite = enhancer.enhance(1.12)

out_path = os.path.join(base_dir, "ibiza_stacked_triptych.jpg")
composite.save(out_path, quality=92)
print("Saved triptych composite to", out_path)
