import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import api_server as api

class StartupStatusTests(unittest.TestCase):
    def test_slow_check_does_not_block_gallery_status_and_recovers(self):
        entered = threading.Event()
        release = threading.Event()
        def slow(device, model="9b"):
            entered.set()
            release.wait(5)
            return {'runtimeReady': True, 'requestedDevice': device}
        api.MODEL_CHECK_STARTED = False
        api.MODEL_CHECK_RESULTS.clear()
        with patch.object(api.flux2, 'model_status', side_effect=slow):
            start = time.monotonic()
            self.assertTrue(api.model_snapshot('AUTO')['checking'])
            self.assertLess(time.monotonic()-start, .5)
            self.assertTrue(entered.wait(1))
            self.assertTrue(api.model_snapshot('CPU')['checking'])
            release.set()
            deadline = time.monotonic()+3
            while not api.MODEL_CHECK_RESULTS and time.monotonic()<deadline:
                time.sleep(.01)
            self.assertTrue(api.model_snapshot('AUTO')['runtimeReady'])
            self.assertTrue(api.model_snapshot('CPU')['runtimeReady'])

if __name__ == '__main__': unittest.main()
