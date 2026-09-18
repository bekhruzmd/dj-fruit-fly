"""Read one local bridge snapshot. Never sends control commands."""
import asyncio
import json
import websockets

async def main():
    async with websockets.connect('ws://127.0.0.1:8766', origin='http://127.0.0.1:5173') as ws:
        message = json.loads(await asyncio.wait_for(ws.recv(), 3))
        print(json.dumps({key: message[key] for key in ('availability', 'state', 'transition', 'diagnostics')}, indent=2))

if __name__ == '__main__':
    import sys
    if '--native' in sys.argv:
        from djay_accessibility import AXReader
        from djay_bridge import get_djay_pid
        reader = AXReader()
        try:
            for _ in range(40): values = reader.read(get_djay_pid())
            print(json.dumps({'values': values, 'cache': list(reader.cache), 'visited': reader.visited,
                              'enabled': reader.control_enabled, 'samples': reader.samples, 'errors': reader.errors, 'writable': reader.writable()}, indent=2))
        finally: reader.close()
    else: asyncio.run(main())
