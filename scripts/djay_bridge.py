#!/usr/bin/env python3
"""Version 1 djay telemetry and PID-scoped keyboard dispatch on localhost:8766."""
import asyncio
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import ctypes as C
import json
import logging
import math
import os
import re
import subprocess
import time
import uuid

from djay_accessibility import AXReader, FIELDS

KEY_LEFT_ARROW, KEY_RIGHT_ARROW, KEY_F = 123, 124, 3
cg = cf = None
try:
    cg = C.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    cf = C.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    for name, result, args in (
        ('CGEventSourceCreate', C.c_void_p, [C.c_int]),
        ('CGEventCreateKeyboardEvent', C.c_void_p, [C.c_void_p, C.c_uint16, C.c_bool]),
        ('CGEventSetFlags', None, [C.c_void_p, C.c_uint64]),
        ('CGEventPostToPid', None, [C.c_int32, C.c_void_p]),
    ):
        fn = getattr(cg, name); fn.restype = result; fn.argtypes = args
    cf.CFRelease.argtypes = [C.c_void_p]; cf.CFRelease.restype = None
except OSError:
    cg = cf = None


def get_djay_pid():
    try:
        output = subprocess.check_output(['ps', '-axo', 'pid=,comm='], timeout=.3, text=True)
        for line in output.splitlines():
            match = re.fullmatch(r'\s*(\d+)\s+(.+)', line)
            if not match:
                continue
            pid, executable = int(match[1]), match[2].strip()
            # comm is an executable path, not an argument string containing 'djay'.
            if pid != os.getpid() and re.fullmatch(r'.*/djay(?: Pro(?: AI)?)?\.app/Contents/MacOS/djay(?: Pro(?: AI)?)?', executable, re.I):
                return pid
    except (OSError, subprocess.SubprocessError):
        pass
    return None
# Exact application executable matching excludes this bridge, shells and search commands.
# A short subprocess timeout bounds process discovery. Renamed application bundles fail closed.


def send_key_press(pid, key_code, with_ctrl=False):
    if not cg or not pid or pid != get_djay_pid():
        return False
    source = cg.CGEventSourceCreate(1)
    if not source:
        return False
    down = up = None
    try:
        down = cg.CGEventCreateKeyboardEvent(source, key_code, True)
        up = cg.CGEventCreateKeyboardEvent(source, key_code, False)
        if not down or not up:
            return False
        if with_ctrl:
            cg.CGEventSetFlags(down, 0x00040000); cg.CGEventSetFlags(up, 0x00040000)
        cg.CGEventPostToPid(pid, down)
        cg.CGEventPostToPid(pid, up)
        return True
    except Exception:
        return False
    finally:
        for ref in (down, up, source):
            if ref:
                cf.CFRelease(ref)
# Events are prepared as a pair and posted only to a freshly verified djay PID. There is no
# active-application fallback. A successful post is dispatch evidence, not proof djay changed.


def unknown_state():
    return {key: {'value': None, 'provenance': 'unknown', 'at': None} for key in FIELDS}
# Each control carries its own evidence instead of sharing a misleading global confirmed flag.
# Null represents an unread value. Consumers must render a neutral unknown state for it.


def validate_control(data):
    if not isinstance(data, dict) or data.get('version') != 1 or data.get('kind') != 'control' or data.get('liveAudio') is not True:
        raise ValueError('versioned live-audio control required')
    if not isinstance(data.get('commandId'), str) or not 1 <= len(data['commandId']) <= 120:
        raise ValueError('command id required')
    values = []
    for key in ('crossfader', 'filterCutoff'):
        value = data.get(key)
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError('finite control values required')
        values.append(max(0., min(1., value)))
    if type(data.get('stutter')) is not bool:
        raise ValueError('boolean stutter required')
    return (*values, data['stutter'])
# Validation rejects non-finite numbers and ambiguous truthy values before native work starts.
# Unit controls are clamped at the boundary. The liveAudio assertion is supplied by the browser.


class DjayController:
    def __init__(self, reader=None, dispatch=None, pid_lookup=None, clock=None):
        self.reader = reader if reader is not None else AXReader()
        self.dispatch = dispatch or send_key_press
        self.pid_lookup = pid_lookup or get_djay_pid
        self.clock = clock or time.monotonic
        self.pid = None
        self.available = False
        self.accessibility = False
        self.state = unknown_state()
        self.estimate = None
        self.baseline = .5
        self.last_stutter = False
        self.last_action_time = -math.inf
    # Injectable native boundaries let tests exercise behavior without sending OS keystrokes.
    # The initial midpoint is only a dispatch baseline. It never becomes confirmed state.

    def poll(self):
        pid = self.pid_lookup()
        if pid != self.pid:
            self.baseline = .5; self.estimate = None; self.last_stutter = False
        self.pid = pid
        self.accessibility = self.reader.trusted()
        self.available = bool(pid and self.accessibility)
        try:
            values = self.reader.read(pid)
        except Exception:
            values = {}
        now = self.clock() * 1000
        self.state = unknown_state()
        for key in FIELDS:
            value = values.get(key)
            valid = type(value) is bool if key.startswith('playing') else type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1
            if valid:
                self.state[key] = {'value': value, 'provenance': 'ax', 'at': now}
        actual = self.state['crossfader']['value']
        if actual is not None:
            self.baseline = actual; self.estimate = None
        if not self.available:
            self.estimate = None
    # Each poll replaces measurements, so a failed read cannot silently preserve confirmed data.
    # Crossfader read-back reanchors future nudges. PID changes discard all dispatch assumptions.

    def process_control(self, data):
        crossfader, _unsupported_filter, stutter = validate_control(data)
        now = self.clock()
        events = []
        pid = self.pid_lookup()
        ready = bool(pid and pid == self.pid and self.reader.trusted())
        diff = crossfader - self.baseline
        intents = []
        if abs(diff) > .03 and now - self.last_action_time >= .08:
            intents.append(('crossfader-left' if diff < 0 else 'crossfader-right', KEY_LEFT_ARROW if diff < 0 else KEY_RIGHT_ARROW, True))
        if stutter and not self.last_stutter:
            intents.append(('cut', KEY_F, False))
        for kind, key, ctrl in intents:
            try:
                success = ready and self.dispatch(pid, key, ctrl)
            except Exception:
                success = False
            events.append({'id': str(uuid.uuid4()), 'commandId': data['commandId'], 'type': kind,
                           'at': self.clock() * 1000, 'status': 'dispatched' if success else 'failed',
                           'provenance': 'native-dispatch', 'reason': None if success else 'djay unavailable or dispatch failed'})
            if ctrl:
                self.last_action_time = now
                if success:
                    self.baseline = max(0., min(1., self.baseline + (-.05 if diff < 0 else .05)))
                    self.estimate = {'value': self.baseline, 'provenance': 'dispatch-estimate', 'at': self.clock() * 1000}
        self.last_stutter = stutter
        return events
    # Only preserved Ctrl-arrow and F shortcuts dispatch; filter requests deliberately do nothing.
    # A successful nudge updates an explicitly heuristic 5% estimate, never AX measurements.
    # Failed dispatches emit failure events and cannot animate a cut or move the estimate.

    def payload(self):
        now = self.clock() * 1000
        estimate = self.estimate if self.estimate and now - self.estimate['at'] <= 1500 else None
        return {'state': self.state, 'estimate': estimate,
                'availability': {'djay': self.pid is not None, 'accessibility': self.accessibility, 'dispatch': self.available and cg is not None},
                'capabilities': {'crossfader': True, 'cut': True, 'filter': False,
                                 'read': {key: self.state[key]['provenance'] == 'ax' for key in FIELDS}}}
    # Snapshots expose per-control read capability separately from supported keyboard actions.
    # Estimates expire after 1.5 seconds without a successful dispatch. No filter or transport
    # estimate exists because no native action or observation supports one.


class BridgeServer:
    def __init__(self, controller=None):
        self.controller = controller or DjayController()
        self.session = str(uuid.uuid4()); self.sequence = 0
        self.clients = set(); self.seen = OrderedDict()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix='djay-native')
        self.lock = asyncio.Lock()
    # One worker bounds native concurrency and keeps AX references on a serialized boundary.
    # The async lock also protects coherent snapshots during dispatch. Session IDs isolate restarts.

    def message(self, kind='snapshot', action=None):
        self.sequence += 1
        return json.dumps({'version': 1, 'kind': kind, 'sessionId': self.session, 'sequence': self.sequence,
                           'sentAt': self.controller.clock() * 1000, **self.controller.payload(), 'action': action}, allow_nan=False)
    # Every wire message has a strictly increasing session sequence and monotonic timestamps.
    # Snapshots contain no action history, so reconnecting cannot replay a cut. JSON rejects NaN.

    async def broadcast(self, kind='snapshot', action=None):
        message = self.message(kind, action)
        async def send(client):
            try:
                await asyncio.wait_for(client.send(message), .5)
            except Exception:
                self.clients.discard(client)
                await client.close()
        await asyncio.gather(*(send(client) for client in tuple(self.clients)))
    # Broadcasting sends one immutable envelope to all clients. Slow sockets are removed rather
    # than accumulating telemetry. The half-second deadline is a local responsiveness assumption.

    async def poll(self):
        loop = asyncio.get_running_loop()
        while True:
            async with self.lock:
                await loop.run_in_executor(self.worker, self.controller.poll)
                await self.broadcast()
            await asyncio.sleep(.2)
    # Native reads and PID discovery run off the event loop at a bounded polling cadence.
    # Polls never overlap or queue indefinitely. Control read-back latency depends on djay's AX tree.

    async def handle_client(self, websocket):
        loop = asyncio.get_running_loop()
        async with self.lock:
            self.clients.add(websocket)
            await websocket.send(self.message())
        try:
            async for raw in websocket:
                async with self.lock:
                    try:
                        data = json.loads(raw)
                        validate_control(data)
                        if data['commandId'] in self.seen:
                            continue
                        self.seen[data['commandId']] = True
                        if len(self.seen) > 512:
                            self.seen.popitem(last=False)
                        actions = await loop.run_in_executor(self.worker, self.controller.process_control, data)
                        for action in actions:
                            await self.broadcast('action', action)
                    except (ValueError, TypeError, json.JSONDecodeError) as error:
                        await websocket.send(self.message('action', {'id': str(uuid.uuid4()), 'commandId': None,
                            'type': 'control', 'at': self.controller.clock() * 1000, 'status': 'rejected',
                            'provenance': 'validation', 'reason': str(error)}))
        finally:
            self.clients.discard(websocket)
    # Client commands are validated and deduplicated before entering the native worker.
    # Failed input gets a typed rejection without OS activity. Recent command IDs survive socket
    # reconnects; clients never resend buffered commands, and the bounded cache covers recent duplicates.


async def main():
    import websockets
    bridge = BridgeServer()
    try:
        async with websockets.serve(bridge.handle_client, '127.0.0.1', 8766, max_size=4096, max_queue=16):
            logging.info('djay bridge listening on ws://127.0.0.1:8766')
            await bridge.poll()
    finally:
        await asyncio.get_running_loop().run_in_executor(bridge.worker, bridge.controller.reader.close)
        bridge.worker.shutdown(wait=False, cancel_futures=True)
# The process exposes only a loopback socket and constrains inbound queue sizes. Cleanup releases
# retained accessibility objects on the native worker. Tests import this module without starting it.


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

# Module summary: Browser motor intent enters a validated dispatcher; native AX feedback supplies
# measured state downstream to the booth and HUD. Keyboard success is only a dispatch estimate.
# No test or bridge startup triggers keys without an explicit live-audio control command.
