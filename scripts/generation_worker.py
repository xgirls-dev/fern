"""Persistent, lazy inference process with cancellation independent of GPU callbacks."""
from __future__ import annotations

import multiprocessing
from pathlib import Path
from threading import Event, Lock


class GenerationCancelled(RuntimeError):
    pass


def inference_loop(connection):
    import flux2_klein_pipeline as flux2
    try:
        while True:
            request = connection.recv()
            try:
                result = flux2.generate_image(**request, log=lambda message: connection.send(("log", message)))
                connection.send(("result", (str(result[0]), result[1])))
            except Exception as error:
                connection.send(("error", str(error)))
    except (EOFError, BrokenPipeError):
        pass
    finally:
        connection.close()


class GenerationWorker:
    def __init__(self, target=inference_loop):
        self.target = target
        self.process = None
        self.connection = None
        self.lock = Lock()

    def close(self):
        if self.process is not None:
            if self.process.is_alive():
                self.process.terminate()
            self.process.join(timeout=2)
            if self.process.is_alive():
                self.process.kill()
                self.process.join(timeout=2)
            self.process.close()
            self.process = None
        if self.connection is not None:
            self.connection.close()
            self.connection = None

    def generate(self, *, cancel_event: Event, log, **request):
        with self.lock:
            if cancel_event.is_set():
                raise GenerationCancelled("Generation stopped by user.")
            if self.process is None or not self.process.is_alive():
                self.close()
                context = multiprocessing.get_context("spawn")
                self.connection, child = context.Pipe()
                self.process = context.Process(target=self.target, args=(child,), daemon=True)
                self.process.start()
                child.close()
            try:
                self.connection.send(request)
                while True:
                    if cancel_event.is_set():
                        raise GenerationCancelled("Generation stopped by user.")
                    if self.connection.poll(0.05):
                        kind, value = self.connection.recv()
                        if kind == "log":
                            log(value)
                        elif kind == "result":
                            return Path(value[0]), value[1]
                        else:
                            raise RuntimeError(value)
                    elif not self.process.is_alive():
                        raise RuntimeError("The generation worker exited. Try generating again.")
            except BaseException:
                self.close()
                raise
