"""Read a bounded, djay-only AX tree; never perform accessibility actions."""
import ctypes as C
import math
import re
import sys
import time

FIELDS = ('crossfader', 'filter1', 'filter2', 'volume1', 'volume2', 'playing1', 'playing2')


def identify_control(role, description):
    if role == 'AXSlider':
        if description.strip().lower() == 'crossfader':
            return 'crossfader'
        match = re.fullmatch(r'(Filter|Line volume), Deck ([12])', description.strip(), re.I)
        if match:
            return ('filter' if match[1].lower() == 'filter' else 'volume') + match[2]
    if role in ('AXButton', 'AXCheckBox'):
        match = re.fullmatch(r'Play / Pause, Deck ([12])', description.strip(), re.I)
        if match:
            return 'playing' + match[1]
    return None
# This matches only known djay control descriptions and roles. Exact scope prevents unrelated
# menu items from masquerading as mixer controls. Localized or redesigned UIs remain unknown.


def normalized_value(field, value, minimum=None, maximum=None):
    if field.startswith('playing'):
        # A button's *description* is never evidence of transport state.
        return bool(value) if type(value) in (bool, int, float) and value in (0, 1) else None
    if isinstance(value, str):
        match = re.fullmatch(r'\s*([+-]?\d+(?:[.,]\d+)?)\s*%\s*', value)
        if not match:
            return None
        result = float(match[1].replace(',', '.')) / 100
    elif type(value) in (int, float) and all(type(v) in (int, float) and math.isfinite(v) for v in (value, minimum, maximum)) and maximum > minimum:
        result = (value - minimum) / (maximum - minimum)
    else:
        return None
    return max(0., min(1., result)) if math.isfinite(result) else None
# This converts measured percentages or explicit slider ranges into unit values. It refuses
# ambiguous bare numbers and button labels. Missing ranges and unsupported values stay unknown.


class AXReader:
    def __init__(self):
        self.pid = None
        self.app = None
        self.cache = {}
        self.queue = []
        self.seen = set()
        self.next_scan = 0.
        self.deadline = 0.
        self.ax = self.cf = None
        if sys.platform != 'darwin':
            return
        try:
            self.ax = C.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
            self.cf = C.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
            signatures = {
                'AXIsProcessTrusted': (C.c_bool, []),
                'AXUIElementCreateApplication': (C.c_void_p, [C.c_int]),
                'AXUIElementSetMessagingTimeout': (C.c_int, [C.c_void_p, C.c_float]),
                'AXUIElementCopyAttributeValue': (C.c_int, [C.c_void_p, C.c_void_p, C.POINTER(C.c_void_p)]),
            }
            for name, (result, args) in signatures.items():
                fn = getattr(self.ax, name); fn.restype = result; fn.argtypes = args
            signatures = {
                'CFRelease': (None, [C.c_void_p]), 'CFRetain': (C.c_void_p, [C.c_void_p]),
                'CFGetTypeID': (C.c_ulong, [C.c_void_p]),
                'CFStringCreateWithCString': (C.c_void_p, [C.c_void_p, C.c_char_p, C.c_uint]),
                'CFStringGetCString': (C.c_bool, [C.c_void_p, C.c_void_p, C.c_long, C.c_uint]),
                'CFNumberGetValue': (C.c_bool, [C.c_void_p, C.c_int, C.c_void_p]),
                'CFBooleanGetValue': (C.c_bool, [C.c_void_p]),
                'CFArrayGetCount': (C.c_long, [C.c_void_p]),
                'CFArrayGetValueAtIndex': (C.c_void_p, [C.c_void_p, C.c_long]),
            }
            for name in ('String', 'Number', 'Boolean', 'Array'):
                signatures['CF' + name + 'GetTypeID'] = (C.c_ulong, [])
            for name, (result, args) in signatures.items():
                fn = getattr(self.cf, name); fn.restype = result; fn.argtypes = args
        except (OSError, AttributeError):
            self.ax = self.cf = None
    # Initialization declares pointer-safe ctypes bindings without prompting for permissions.
    # Only system frameworks are loaded. Unsupported platforms expose an unavailable reader.

    def trusted(self):
        return bool(self.ax and self.ax.AXIsProcessTrusted())
    # Trust is queried without opening a system prompt. Dispatch and reads share this permission
    # signal. Trust alone does not prove any particular djay control exists.

    def close(self):
        if self.cf:
            for ref in list(self.cache.values()) + self.queue + ([self.app] if self.app else []):
                self.cf.CFRelease(ref)
        self.cache = {}; self.queue = []; self.seen = set(); self.app = None; self.pid = None
    # Every retained tree node has an owner here. Reset releases cached and pending references.
    # Call only on the reader's single worker thread, including when djay changes PID.

    def _copy(self, node, attribute):
        if time.monotonic() >= self.deadline:
            return None
        key = self.cf.CFStringCreateWithCString(None, attribute.encode(), 0x08000100)
        out = C.c_void_p()
        try:
            error = self.ax.AXUIElementCopyAttributeValue(node, key, C.byref(out))
            return out.value if error == 0 else None
        finally:
            self.cf.CFRelease(key)
    # A deadline gates each AX request as well as the native per-message timeout. Returned
    # references belong to the caller. An unsupported or unresponsive attribute yields no value.

    def _value(self, node, attribute):
        ref = self._copy(node, attribute)
        if not ref:
            return None
        try:
            kind = self.cf.CFGetTypeID(ref)
            if kind == self.cf.CFStringGetTypeID():
                buffer = C.create_string_buffer(1024)
                return buffer.value.decode('utf-8') if self.cf.CFStringGetCString(ref, buffer, len(buffer), 0x08000100) else None
            if kind == self.cf.CFBooleanGetTypeID():
                return bool(self.cf.CFBooleanGetValue(ref))
            if kind == self.cf.CFNumberGetTypeID():
                number = C.c_double()
                return number.value if self.cf.CFNumberGetValue(ref, 13, C.byref(number)) else None
            return None
        finally:
            self.cf.CFRelease(ref)
    # Scalar conversion accepts only CF strings, booleans and numbers. Other AX objects are
    # intentionally ignored. The copy is released even when conversion cannot represent it.

    def read(self, pid):
        result = {field: None for field in FIELDS}
        if pid != self.pid:
            self.close()
        if not pid or not self.trusted():
            self.close()
            return result
        self.deadline = time.monotonic() + .35
        if not self.app:
            self.pid = pid
            self.app = self.ax.AXUIElementCreateApplication(pid)
            if not self.app:
                return result
            self.ax.AXUIElementSetMessagingTimeout(self.app, .025)
        # Cached controls get first access to the budget, so discovery cannot starve feedback.
        for field, node in list(self.cache.items()):
            value = self._value(node, 'AXValue')
            lo = hi = None
            if not field.startswith('playing') and type(value) in (float, int):
                lo = self._value(node, 'AXMinValue'); hi = self._value(node, 'AXMaxValue')
            result[field] = normalized_value(field, value, lo, hi)
        if not self.queue and time.monotonic() >= self.next_scan:
            self.queue = [self.cf.CFRetain(self.app)]
            self.seen = set()
            self.next_scan = time.monotonic() + 5
        while self.queue and time.monotonic() < self.deadline:
            node = self.queue.pop(0)
            try:
                identity = node
                if identity in self.seen or len(self.seen) >= 6000:
                    continue
                self.seen.add(identity)
                self.ax.AXUIElementSetMessagingTimeout(node, .025)
                role = self._value(node, 'AXRole')
                if role in ('AXSlider', 'AXButton', 'AXCheckBox'):
                    field = identify_control(role, self._value(node, 'AXDescription') or '')
                    if field:
                        if field in self.cache:
                            self.cf.CFRelease(self.cache[field])
                        self.cache[field] = self.cf.CFRetain(node)
                children = self._copy(node, 'AXChildren')
                if children:
                    try:
                        if self.cf.CFGetTypeID(children) == self.cf.CFArrayGetTypeID():
                            count = min(self.cf.CFArrayGetCount(children), max(0, 6000 - len(self.queue) - len(self.seen)))
                            for index in range(count):
                                child = self.cf.CFArrayGetValueAtIndex(children, index)
                                self.queue.append(self.cf.CFRetain(child))
                    finally:
                        self.cf.CFRelease(children)
            finally:
                self.cf.CFRelease(node)
        return result
    # Polling reads retained controls first and incrementally discovers a bounded djay tree.
    # A 350ms budget and 25ms AX timeout are initial responsiveness limits, not measured latency.
    # Layout changes can delay discovery; absent or unreadable controls are never carried forward.

# Module summary: This is a read-only, dependency-free adapter for the native accessibility boundary.
# Values come from AXValue, with exact descriptions identifying their controls. It is designed
# for one serialized background worker; it neither guesses playback nor manipulates the OS UI.
