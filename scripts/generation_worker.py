"""Persistent, lazy inference process with cancellation independent of GPU callbacks."""
from __future__ import annotations

import multiprocessing
from pathlib import Path
from threading import Event, Lock


class GenerationCancelled(RuntimeError):
    pass


def inference_loop(connection):
    import flux2_klein_pipeline as flux2
    from model_catalog import APPLE_IMAGE_ID

    def log(message):
        connection.send(("log", message))

    try:
        while True:
            request = connection.recv()
            try:
                if request.get("model") == APPLE_IMAGE_ID:
                    import apple_image

                    fields = ("prompt", "width", "height", "steps", "seed", "output_dir")
                    result = apple_image.generate_image(
                        root=flux2.MODELS_ROOT, log=log, **{field: request[field] for field in fields}
                    )
                else:
                    result = flux2.generate_image(**request, log=log)
                connection.send(("result", (str(result[0]), result[1])))
            except Exception as error:
                connection.send(("error", str(error)))
    except (EOFError, BrokenPipeError):
        pass
    finally:
        connection.close()


def tame_pony_inference_loop(connection):
    """Keep SDXL imports and OpenVINO allocations out of the Fern API process."""
    import tame_pony_pipeline as pony

    try:
        while True:
            request = connection.recv()
            try:
                result = pony.generate_image(
                    **request,
                    log=lambda message: connection.send(("log", message)),
                )
                connection.send(("result", (str(result[0]), result[1])))
            except Exception as error:
                connection.send(("error", str(error)))
    except (EOFError, BrokenPipeError):
        pass
    finally:
        connection.close()


def custom_image_inference_loop(connection):
    """Isolate dynamic OpenVINO GenAI image pipelines from the API process."""
    import custom_image_pipeline as custom

    try:
        while True:
            request = connection.recv()
            try:
                result = custom.generate_image(
                    **request,
                    log=lambda message: connection.send(("log", message)),
                )
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
        if self.lock.acquire(blocking=False):
            try:
                self._close_unlocked(graceful=True)
            finally:
                self.lock.release()
            return
        self.interrupt()
        with self.lock:
            self._close_unlocked()

    def _close_unlocked(self, *, graceful=False):
        if self.connection is not None:
            self.connection.close()
            self.connection = None
        process = self.process
        if process is None:
            return
        # Closing the pipe lets the idle loop exit and release its runtime.
        if graceful:
            process.join(timeout=0.75)
        if process.is_alive():
            process.terminate()
            process.join(timeout=2)
        if process.is_alive():
            process.kill()
            process.join(timeout=4)
        if process.is_alive():
            raise RuntimeError("The image worker is still releasing GPU resources. Try again in a moment.")
        process.close()
        self.process = None

    def interrupt(self):
        """Terminate an in-flight inference process so cancellation is immediate."""
        process = self.process
        if process is not None:
            try:
                if process.is_alive():
                    process.terminate()
            except (AssertionError, OSError, ValueError):
                # The generate thread may have concurrently reaped the process.
                pass

    def generate(self, *, cancel_event: Event, log, **request):
        with self.lock:
            if cancel_event.is_set():
                raise GenerationCancelled("Generation stopped by user.")
            if self.connection is None or self.process is None or not self.process.is_alive():
                self._close_unlocked()
                context = multiprocessing.get_context("spawn")
                parent, child = context.Pipe()
                process = context.Process(target=self.target, args=(child,), daemon=True)
                try:
                    process.start()
                except BaseException:
                    parent.close()
                    raise
                finally:
                    child.close()
                self.process = process
                self.connection = parent
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
            except BaseException as error:
                try:
                    self._close_unlocked()
                except (OSError, RuntimeError) as cleanup_error:
                    error.add_note(str(cleanup_error))
                raise
