import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import subprocess
import sys
import unittest


@unittest.skipUnless(os.name == "nt", "Windows job objects require Windows")
class WindowsServiceJobTests(unittest.TestCase):
    def test_service_exit_terminates_its_worker(self):
        scripts = Path(__file__).resolve().parents[1] / "scripts"
        code = """
import os
import subprocess
import sys

from windows_service_job import contain_service_process_tree

contain_service_process_tree()
worker = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
                          stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(worker.pid, flush=True)
sys.stdin.readline()
os._exit(24)
"""
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel.CloseHandle.restype = wintypes.BOOL
        with subprocess.Popen([sys.executable, "-c", code], cwd=scripts,
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as service:
            try:
                worker_pid = int(service.stdout.readline())
                synchronize = 0x00100000
                worker = kernel.OpenProcess(synchronize, False, worker_pid)
                if not worker:
                    raise ctypes.WinError(ctypes.get_last_error())
                try:
                    self.assertEqual(kernel.WaitForSingleObject(worker, 0), 258)
                    service.stdin.write("\n")
                    service.stdin.flush()
                    self.assertEqual(service.wait(timeout=5), 24)
                    self.assertEqual(kernel.WaitForSingleObject(worker, 5_000), 0)
                finally:
                    kernel.CloseHandle(worker)
            finally:
                if service.poll() is None:
                    service.kill()
