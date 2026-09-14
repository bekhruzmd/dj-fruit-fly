"""Local-only analysis endpoint, reached through Vite's /api/analysis proxy."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse
from analysis.analyzer import cached_analysis

MAX_UPLOAD = 100 * 1024 * 1024
CACHE = Path(__file__).resolve().parent.parent / '.cache' / 'track-analysis'


class AnalysisHandler(BaseHTTPRequestHandler):
    def reply(self, status: int, body: dict) -> None:
        payload = json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass
    # Summary: This sends a predictable JSON result or failure to the browser.
    # Explicit framing lets the caller distinguish a cache hit, invalid track, and server failure.
    # A cancelled browser request can disconnect while analysis is still finishing.

    def do_POST(self) -> None:
        # No cross-origin API or arbitrary path reads: the local app sends raw bytes.
        # Serial processing bounds simultaneous FFT memory; this is a local tool,
        # not the queued multi-user service a public deployment would require.
        origin = self.headers.get('Origin')
        if origin and urlparse(origin).hostname not in ('localhost', '127.0.0.1'):
            self.reply(403, {'error': 'Only local application origins are supported.'})
            return
        if self.path != '/api/analysis':
            self.reply(404, {'error': 'Unknown endpoint.'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_UPLOAD:
                self.reply(413, {'error': 'Upload an audio file smaller than 100 MB.'})
                return
            self.connection.settimeout(60)
            data = self.rfile.read(length)
            if len(data) != length:
                raise ValueError('Incomplete upload.')
            result, hit = cached_analysis(data, CACHE)
            self.reply(200, {'analysis': result, 'cacheHit': hit})
        except (ValueError, RuntimeError) as error:
            self.reply(422, {'error': f'Could not analyze this audio: {error}'})
        except Exception:
            self.reply(500, {'error': 'Analysis failed. Check the local analyzer terminal.'})
            import traceback
            traceback.print_exc()
    # Summary: This accepts one bounded audio upload and returns its cached or newly computed analysis.
    # A single local worker avoids competing large decoded buffers and keeps raw audio off external services.
    # Long tracks can take time, unsupported codecs fail decoding, and this is not a public deployment server.


def main() -> None:
    server = HTTPServer(('127.0.0.1', 8765), AnalysisHandler)
    print('Neuro-DJ analyzer: http://127.0.0.1:8765 (Ctrl+C to stop)', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
# Summary: This starts the analyzer on a fixed loopback port for the local development workflow.
# Vite proxies same-origin browser requests to it, while Python owns decoding and analysis.
# Another process using port 8765 prevents startup; hosted deployment needs an explicit backend arrangement.


if __name__ == '__main__':
    main()

# Module summary: This module connects the browser upload flow to the Python analyzer.
# It returns structured errors and metadata while caching only analysis, not uploaded recordings.
# Cancellation closes the browser request but does not interrupt an in-progress Python analysis.
