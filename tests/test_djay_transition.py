import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from djay_transition import AssistedTransition, targets, REQUIRED
from djay_accessibility import identify_control, normalized_value


class TransitionTests(unittest.TestCase):
    def setUp(self):
        self.now = 0.
        self.mix = AssistedTransition(lambda: self.now)
        self.values = dict(crossfader=0., bass1=.5, bass2=.5, volume1=1., volume2=1., filter1=.5, filter2=.5, playing1=True, playing2=True)
        self.writable = dict.fromkeys(REQUIRED, True)
        self.writes = []

    def move(self, field, target):
        self.values[field] = target
        self.writes.append((field, target))
        return target

    def command(self, op, **kwargs):
        self.mix.command(dict(operation=op, liveAudio=True, source=1, bpm=120, confirmed=True, **kwargs), self.values, self.writable, True)

    def tick(self, seconds=.1, heartbeat=True, move=None):
        self.now += seconds
        if heartbeat: self.mix.heartbeat = self.now
        self.mix.tick(self.values, self.writable, True, move or self.move)

    def start(self):
        self.command('prepare'); self.tick()
        self.assertEqual(self.mix.phase, 'ready')
        self.command('start')

    def test_prepare_only_changes_inaudible_bass(self):
        self.command('prepare'); self.tick()
        self.assertEqual(self.writes, [('bass2', 0)])
        self.assertEqual(self.values['crossfader'], 0)

    def test_complete_exact_eight_bars_both_directions(self):
        for source in (1, 2):
            self.setUp()
            self.values['crossfader'] = source - 1
            data = dict(liveAudio=True, source=source, bpm=120, confirmed=True)
            self.mix.command(dict(operation='prepare', **data), self.values, self.writable, True)
            self.tick()
            self.mix.command(dict(operation='start', **data), self.values, self.writable, True)
            for _ in range(159): self.tick()
            self.assertEqual(self.mix.phase, 'running')
            self.tick(.101)
            self.assertEqual(self.mix.phase, 'complete')
            self.assertAlmostEqual(self.values['crossfader'], 2-source)
            self.assertEqual(self.values[f'bass{source}'], 0)
            self.assertEqual(self.values[f'bass{3-source}'], .5)

    def test_never_overlap_bass_and_monotonic_blend(self):
        previous = -1
        for i in range(1001):
            t = targets(i/1000, 1)
            self.assertLessEqual(min(t['bass1'], t['bass2']), 1e-10)
            self.assertGreaterEqual(t['crossfader'], previous)
            previous = t['crossfader']

    def test_start_refuses_unprepared_or_unconfirmed(self):
        with self.assertRaises(ValueError): self.command('start')
        self.command('prepare'); self.tick()
        with self.assertRaises(ValueError):
            self.mix.command(dict(operation='start', source=1, bpm=120, liveAudio=True, confirmed=False), self.values, self.writable, True)
        self.assertEqual(self.mix.phase, 'ready')

    def test_missing_readback_and_capability_block(self):
        self.values['bass2'] = None
        with self.assertRaises(ValueError): self.command('prepare')
        self.assertEqual(self.writes, [])
        self.values['bass2'] = .5; self.writable['crossfader'] = False
        with self.assertRaises(ValueError): self.command('prepare')

    def test_stop_no_more_writes_or_reset(self):
        self.start(); self.tick(0.5)
        before = dict(self.values); n = len(self.writes)
        self.command('stop'); self.tick()
        self.assertEqual(self.values, before); self.assertEqual(len(self.writes), n)

    def test_heartbeat_and_stall_stop_without_jump(self):
        self.start(); n = len(self.writes)
        self.tick(2, heartbeat=False)
        self.assertEqual(self.mix.phase, 'stopped'); self.assertEqual(len(self.writes), n)
        self.setUp(); self.start(); n = len(self.writes)
        self.tick(1.1)
        self.assertEqual(self.mix.phase, 'stopped'); self.assertEqual(len(self.writes), n)

    def test_manual_override_and_paused_deck_stop(self):
        self.start(); self.values['crossfader'] = .3; n = len(self.writes); self.tick()
        self.assertEqual(self.mix.phase, 'stopped'); self.assertEqual(len(self.writes), n)
        self.setUp(); self.start(); self.values['playing2'] = False; self.tick()
        self.assertEqual(self.mix.phase, 'stopped')

    def test_failed_and_nonmoving_native_controls(self):
        self.start(); self.tick(move=lambda field, target: None)
        self.assertEqual(self.mix.phase, 'stopped')
        self.setUp(); self.start()
        for _ in range(100):
            self.tick(move=lambda field, target: self.values[field])
            if self.mix.phase == 'stopped': break
        self.assertEqual(self.mix.phase, 'stopped')
        self.assertIn('keep up', self.mix.reason)

    def test_invalid_inputs_cannot_write(self):
        for bpm in (float('nan'), float('inf'), 0, 181, '120', True):
            with self.assertRaises(ValueError):
                self.mix.command(dict(operation='prepare', source=1, bpm=bpm, liveAudio=True), self.values, self.writable, True)
        self.assertFalse(self.writes)

    def test_ax_control_names_and_unknown_transport(self):
        self.assertEqual(identify_control('AXSlider', 'Low EQ, Deck 2'), 'bass2')
        self.assertEqual(identify_control('AXButton', 'Sync, Deck 1'), 'sync1')
        self.assertIsNone(identify_control('AXSlider', 'Neural Mix Bass, Deck 1'))
        self.assertIsNone(normalized_value('playing1', 'Play / Pause'))
        self.assertEqual(normalized_value('bass1', '50%'), .5)
        self.assertTrue(normalized_value('sync1', 'Active'))

if __name__ == '__main__': unittest.main()
