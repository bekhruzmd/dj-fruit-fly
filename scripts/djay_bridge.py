#!/usr/bin/env python3
"""Local djay telemetry and explicitly started, verified assisted transitions."""
import asyncio
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import json
import logging
import math
import os
import re
import subprocess
import time
import uuid

from djay_accessibility import AXReader, FIELDS
from djay_transition import AssistedTransition, ACTIVE

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


def unknown_state():
    return {key: {'value': None, 'provenance': 'unknown', 'at': None} for key in FIELDS}
# Each control carries its own evidence instead of sharing a misleading global confirmed flag.
# Null represents an unread value. Consumers must render a neutral unknown state for it.


class DjayController:
    def __init__(self, reader=None, pid_lookup=None, clock=None):
        self.reader = reader if reader is not None else AXReader()
        self.pid_lookup = pid_lookup or get_djay_pid
        self.clock = clock or time.monotonic
        self.pid = None
        self.available = False
        self.accessibility = False
        self.state = unknown_state()
        self.transition = AssistedTransition(self.clock)
        self.values = {}
        self.writable = {}
    # Injectable native boundaries let tests exercise behavior without sending OS keystrokes.
    # The initial midpoint is only a dispatch baseline. It never becomes confirmed state.

    def poll(self):
        pid = self.pid_lookup()
        if pid != self.pid:
            if self.transition.phase in ACTIVE: self.transition.stop('Stopped: djay restarted.')
        self.pid = pid
        self.accessibility = self.reader.trusted()
        self.available = bool(pid and self.accessibility)
        try:
            values = self.reader.read(pid)
            writable = self.reader.writable()
        except Exception:
            values, writable = {}, {}
        self.values = values
        self.writable = writable
        self.transition.tick(values, self.writable, self.available, self.reader.move)
        now = self.clock() * 1000
        self.state = unknown_state()
        for key in FIELDS:
            value = values.get(key)
            valid = type(value) is bool if key.startswith('playing') else type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1
            if valid:
                self.state[key] = {'value': value, 'provenance': 'ax', 'at': now}
    def process_transition(self, data):
        if self.pid != self.pid_lookup() or not self.reader.trusted():
            self.transition.stop('djay or Accessibility became unavailable.')
            if data.get('operation') not in ('stop', 'heartbeat'):
                raise ValueError('djay or Accessibility unavailable')
        op = data.get('operation')
        if op == 'press':
            if self.transition.phase in ACTIVE: raise ValueError('Stop the transition before changing transport')
            field = data.get('field')
            if field not in ('playing1', 'playing2', 'sync1', 'sync2', 'cue1', 'cue2') or not self.writable.get(field):
                raise ValueError('This deck control is unavailable')
            self.reader.deadline = self.clock() + .15
            if not self.reader.press(field): raise ValueError('djay did not accept the deck action')
            self.transition.reason = 'Deck action sent. Check playback and sync in djay before starting.'
            return
        self.transition.command(data, self.values, self.writable, self.available)

    def payload(self):
        return {'state': self.state, 'estimate': None,
                'transition': self.transition.snapshot(self.values, self.writable, self.available),
                'diagnostics': {'controls': list(self.reader.cache), 'visited': self.reader.visited, 'pending': len(self.reader.queue), 'axErrors': self.reader.errors},
                'availability': {'djay': self.pid is not None, 'accessibility': self.accessibility, 'dispatch': self.available and any(self.writable.values())},
                'capabilities': {'crossfader': bool(self.writable.get('crossfader')), 'cut': False, 'filter': False,
                                 'read': {key: self.state[key]['provenance'] == 'ax' for key in FIELDS}}}
    # Snapshots expose per-control read capability separately from supported keyboard actions.
    # Only measured AX values are reported. No heuristic keyboard estimates are emitted.


class BridgeServer:
    def __init__(self, controller=None):
        self.controller = controller or DjayController()
        self.session = str(uuid.uuid4()); self.sequence = 0
        self.clients = set(); self.seen = OrderedDict()
        self.owner = None
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
            await asyncio.sleep(.08)
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
                        if not isinstance(data, dict) or data.get('version') != 1 or data.get('kind') != 'transition':
                            raise ValueError('Use versioned assisted transition commands')
                        if not isinstance(data.get('commandId'), str) or not 1 <= len(data['commandId']) <= 120:
                            raise ValueError('Command ID required')
                        if data['commandId'] in self.seen:
                            continue
                        self.seen[data['commandId']] = True
                        if len(self.seen) > 512:
                            self.seen.popitem(last=False)
                        operation = data.get('operation')
                        if operation == 'heartbeat' and websocket is not self.owner:
                            continue
                        if operation in ('start', 'prepare') and self.controller.transition.phase in ACTIVE:
                            raise ValueError('A transition is already active')
                        if operation == 'press' and self.controller.transition.phase in ACTIVE:
                            raise ValueError('Stop the current transition before changing decks')
                        await loop.run_in_executor(self.worker, self.controller.process_transition, data)
                        if operation in ('start', 'prepare'):
                            self.owner = websocket
                        await self.broadcast()
                    except (ValueError, TypeError, json.JSONDecodeError) as error:
                        await websocket.send(self.message('action', {'id': str(uuid.uuid4()), 'commandId': None,
                            'type': 'control', 'at': self.controller.clock() * 1000, 'status': 'rejected',
                            'provenance': 'validation', 'reason': str(error)}))
        finally:
            async with self.lock:
                self.clients.discard(websocket)
                if websocket is self.owner:
                    await loop.run_in_executor(self.worker, self.controller.transition.stop, 'Stopped: controlling browser disconnected.')
                    self.owner = None
    # Client commands are validated and deduplicated before entering the native worker.
    # Failed input gets a typed rejection without OS activity. Recent command IDs survive socket
    # reconnects; clients never resend buffered commands, and the bounded cache covers recent duplicates.


async def main():
    import websockets
    bridge = BridgeServer()
    try:
        async with websockets.serve(bridge.handle_client, '127.0.0.1', 8766,
                                    origins=['http://127.0.0.1:5173', 'http://localhost:5173'],
                                    max_size=4096, max_queue=16):
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

# No startup or connection initiates playback or mixer movement. Explicit commands own one transition.
