"""One explicit 32-beat transition, driven by a monotonic server clock and AX feedback."""
import math

ACTIVE = ('preparing', 'running', 'settling')
REQUIRED = ('crossfader', 'bass1', 'bass2', 'volume1', 'volume2', 'filter1', 'filter2')


def targets(progress, source):
    p = max(0., min(1., progress))
    smooth = p * p * (3 - 2 * p)
    outgoing = .5 * (1 - max(0., min(1., (p - .40) / .10)))
    incoming = .5 * max(0., min(1., (p - .50) / .10))
    return {'crossfader': smooth if source == 1 else 1 - smooth,
            f'bass{source}': outgoing, f'bass{3-source}': incoming}


class AssistedTransition:
    def __init__(self, clock):
        self.clock = clock
        self.phase = 'idle'
        self.reason = 'Load two tracks and prepare the incoming deck.'
        self.source = 1
        self.bpm = 120.
        self.progress = 0.
        self.started = self.heartbeat = self.last_tick = 0.
        self.expected = {}
        self.lag_since = None

    def stop(self, reason='Stopped. Mixer left at its current position.'):
        self.phase = 'stopped'
        self.reason = reason
        self.expected = {}

    def readiness(self, values, writable, available):
        if not available: return 'Open djay and allow Accessibility for the bridge terminal.'
        missing = [f for f in REQUIRED if values.get(f) is None or not writable.get(f)]
        if missing: return 'Controls unavailable: ' + ', '.join(missing) + '. Show the two-deck mixer with classic EQ.'
        return None

    def command(self, data, values, writable, available):
        op = data.get('operation')
        if op == 'stop':
            self.stop(); return
        if op == 'heartbeat':
            if data.get('liveAudio') is not True: self.stop('Audio listening stopped.')
            else: self.heartbeat = self.clock()
            return
        if op not in ('prepare', 'start'): raise ValueError('Unknown transition operation')
        if self.phase in ACTIVE: raise ValueError('Stop the current transition first')
        source, bpm = data.get('source'), data.get('bpm')
        if type(source) is not int or source not in (1, 2): raise ValueError('Choose source deck 1 or 2')
        if type(bpm) not in (int, float) or not math.isfinite(bpm) or not 60 <= bpm <= 180:
            raise ValueError('Enter the synced tempo, 60–180 BPM')
        problem = self.readiness(values, writable, available)
        if problem: raise ValueError(problem)
        if data.get('liveAudio') is not True: raise ValueError('Start audio listening first')
        if abs(values['crossfader'] - (source - 1)) > .025:
            raise ValueError('Move the crossfader fully to the source deck in djay first')
        for deck in (1, 2):
            if values[f'volume{deck}'] < .9: raise ValueError('Raise both channel volumes in djay')
            if abs(values[f'filter{deck}'] - .5) > .03: raise ValueError('Center both filters in djay')
        if abs(values[f'bass{source}'] - .5) > .03:
            raise ValueError('Center the source deck Low EQ in djay')
        if op == 'start':
            if values[f'bass{3-source}'] > .025: raise ValueError('Prepare the incoming bass first')
            if data.get('confirmed') is not True: raise ValueError('Confirm both decks are playing in beat sync')
            if any(values.get(f'playing{deck}') is False for deck in (1, 2)):
                raise ValueError('Both decks must be playing')
        self.source, self.bpm = source, float(bpm)
        self.progress = 0.
        self.started = self.heartbeat = self.last_tick = self.clock()
        self.expected = {f: values[f] for f in ('crossfader', 'bass1', 'bass2')}
        self.lag_since = None
        self.phase = 'preparing' if op == 'prepare' else 'running'
        self.reason = 'Lowering the inaudible incoming bass.' if op == 'prepare' else 'Blending 8 bars · manual phrase start'

    def tick(self, values, writable, available, move):
        if self.phase not in ACTIVE: return
        now = self.clock()
        if now - self.heartbeat > 1.5: self.stop('Stopped: browser/audio heartbeat lost.'); return
        if now - self.last_tick > 1.: self.stop('Stopped: timing stalled. Start again on a new phrase.'); return
        self.last_tick = now
        problem = self.readiness(values, writable, available)
        if problem: self.stop(problem); return
        if any(abs(values[f] - v) > .065 for f, v in self.expected.items()):
            self.stop('Stopped: mixer moved outside this transition.'); return
        if any(values[f'volume{d}'] < .9 or abs(values[f'filter{d}'] - .5) > .03 for d in (1, 2)):
            self.stop('Stopped: channel volume or filter changed.'); return
        if self.phase == 'preparing':
            desired = {f'bass{3-self.source}': 0.}
            if now - self.started > 4.: self.stop('Preparation timed out: bass did not reach its target.'); return
        else:
            if any(values.get(f'playing{d}') is False for d in (1, 2)):
                self.stop('Stopped: a deck paused.'); return
            self.progress = min(1., (now - self.started) / (32 * 60 / self.bpm))
            desired = targets(self.progress, self.source)
        error = 0.
        for field, target in desired.items():
            try: actual = move(field, target)
            except Exception: actual = None
            if actual is None or not math.isfinite(actual):
                self.stop(f'Stopped: {field} could not be verified.'); return
            self.expected[field] = actual
            error = max(error, abs(actual - target))
        if error > .10 and self.phase != 'preparing':
            if self.lag_since is None: self.lag_since = now
            elif now - self.lag_since > .8: self.stop('Stopped: djay controls cannot keep up with the blend.'); return
        else: self.lag_since = None
        if self.phase == 'preparing' and error <= .015:
            self.phase = 'ready'; self.reason = 'Incoming bass prepared. Play and sync both decks; start on a phrase downbeat.'
        elif self.progress == 1.:
            if error <= .015:
                self.phase = 'complete'; self.reason = f'Complete · Deck {3-self.source} is on air. Outgoing bass remains cut.'
            elif now - self.started > 32 * 60 / self.bpm + 1.:
                self.stop('Endpoint was not confirmed. Check the mixer.')
            else: self.phase = 'settling'

    def snapshot(self, values, writable, available):
        return {'phase': self.phase, 'reason': self.reason, 'source': self.source, 'bpm': self.bpm,
                'progress': self.progress, 'ready': self.readiness(values, writable, available) is None,
                'blocker': self.readiness(values, writable, available),
                'bass': [values.get('bass1'), values.get('bass2')],
                'writable': {f: bool(writable.get(f)) for f in REQUIRED + ('playing1', 'playing2', 'sync1', 'sync2', 'cue1', 'cue2')}}
