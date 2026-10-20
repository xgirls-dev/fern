"""Isolated local API for headless integration tests; never touches user data."""
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import api_server as api

server = ThreadingHTTPServer(('127.0.0.1', 0), api.Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
print(f'FIXTURE_PORT={server.server_port}', flush=True)
try:
    sys.stdin.readline()
finally:
    server.shutdown()
    api.TEXT_GENERATION_WORKER.close()
    server.server_close()
