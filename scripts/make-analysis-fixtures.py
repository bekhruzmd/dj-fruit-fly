"""Generate small, reproducible uploads for the browser analysis tests."""
import runpy
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root))
pulse_audio = runpy.run_path(str(root / 'tests' / 'test_analysis.py'))['pulse_audio']
directory = root / '.cache' / 'fixtures'
directory.mkdir(parents=True, exist_ok=True)
for bpm in (125, 90):
    (directory / f'pulse{bpm}.wav').write_bytes(pulse_audio(bpm, duration=24))
print(f'Created analysis fixtures in {directory}')
# Module summary: This creates known-tempo audio files for real browser uploads.
# It reuses the Python regression fixture generator so UI and analyzer checks use identical signals.
# These simple pulses are not a replacement for listening tests with real musical arrangements.
