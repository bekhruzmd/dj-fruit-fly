import os
from PIL import Image, ImageFilter, ImageOps, ImageEnhance

base_dir = "public/images/ibiza"
img_hi = Image.open(os.path.join(base_dir, "hi_ibiza_lasers.png")).convert("RGB")
img_pano = Image.open(os.path.join(base_dir, "ibiza_panorama.jpg")).convert("RGB")
img_ush = Image.open(os.path.join(base_dir, "ushuaia_stage.png")).convert("RGB")

target_w = 1920
target_h = 1080

# Create a composite canvas (1920x1080)
# Top ~35%: Hï Ibiza ceiling & lasers
# Middle ~40%: Ushuaïa aerial dusk panorama & airplane
# Bottom ~35%: Ushuaïa main stage & crowd

composite = Image.new("RGB", (target_w, target_h), (10, 4, 20))

# 1. Resize images to target width while keeping proportions
def cover_crop(img, w, h):
    ratio = max(w / img.width, h / img.height)
    new_size = (int(img.width * ratio), int(img.height * ratio))
    resized = img.resize(new_size, Image.Resampling.LANCZOS)
    left = (resized.width - w) // 2
    top = (resized.height - h) // 2
    return resized.crop((left, top, left + w, top + h))

# Prepare 3 slices with slight overlaps for smooth gradient blending
h_slice = 430
top_slice = cover_crop(img_hi, target_w, h_slice)
mid_slice = cover_crop(img_pano, target_w, h_slice + 80)
bot_slice = cover_crop(img_ush, target_w, h_slice)

# Paste top slice at y=0
composite.paste(top_slice, (0, 0))

# Blend mid slice with a soft gradient mask
y_mid = 320
mid_mask = Image.new("L", (target_w, mid_slice.height), 255)
# Feather top of mid mask
for y in range(80):
    alpha = int((y / 80.0) * 255)
    for x in range(target_w):
        mid_mask.putpixel((x, y), alpha)

composite.paste(mid_slice, (0, y_mid), mid_mask)

# Blend bottom slice with a soft gradient mask
y_bot = target_h - h_slice
bot_mask = Image.new("L", (target_w, bot_slice.height), 255)
# Feather top of bot mask
for y in range(90):
    alpha = int((y / 90.0) * 255)
    for x in range(target_w):
        bot_mask.putpixel((x, y), alpha)

composite.paste(bot_slice, (0, y_bot), bot_mask)

# Add subtle dark vignette & atmospheric grading
enhancer = ImageEnhance.Color(composite)
composite = enhancer.enhance(1.15)
enhancer = ImageEnhance.Contrast(composite)
composite = enhancer.enhance(1.08)

out_path = os.path.join(base_dir, "ibiza_stacked_bg.jpg")
composite.save(out_path, quality=92)
print("Saved stacked composite to", out_path)
