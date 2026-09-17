"""Generate one small original reference-only lesson without network access."""
import json
from pathlib import Path
import sys
import tempfile

import numpy as np
import soundfile as sf

root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root))
from lesson_builder.export import export_lesson, prepare_lesson
from lesson_builder.importer import import_local_file
from lesson_builder.schema import validate_lesson


def main():
    out = root / "examples" / "lessons"
    target = out / "synthetic-chord-pulses-v1"
    if target.exists():
        errors = validate_lesson(json.loads((target / "lesson.json").read_text()))
        if errors:
            raise ValueError("Existing example is invalid: " + "; ".join(errors))
        print(f"Validated existing example: {target}")
        return
    with tempfile.TemporaryDirectory(prefix="lesson-example-") as temporary:
        work = Path(temporary)
        sr, seconds = 22050, 3
        t = np.arange(sr * seconds) / sr
        chord = sum(.045 * np.sin(2 * np.pi * frequency * t) for frequency in (220, 275, 330))
        pulses = .2 * np.sin(2 * np.pi * 65 * t) * np.exp(-((t - .32) % .5) * 45)
        sf.write(work / "original.wav", chord + pulses, sr, subtype="PCM_16")
        raw = import_local_file(work / "original.wav", True)
        built = prepare_lesson(raw, work / "prepared", title="Original synthetic chord and pulses",
            human_annotations={"notes": "Authored synthetic fixture, 3 seconds. No controller log or separately supplied decks."})
        built.lesson["lessonId"] = "synthetic-chord-pulses"
        folder = export_lesson(built, out)
        errors = validate_lesson(json.loads((folder / "lesson.json").read_text()))
        if errors:
            raise ValueError("; ".join(errors))
        print(f"Generated and validated example: {folder}")
# Summary: This builds a real exported lesson from original generated PCM and makes repeated runs validate the same example.
# Short synthetic pulses cannot establish a reliable tempo estimate, action supervision, or real-world musical quality.


if __name__ == "__main__":
    main()

# Module summary: This is the reproducible offline example generator, with one small committed artifact folder.
# The reference-only example demonstrates data contracts, not an imitation training method.
