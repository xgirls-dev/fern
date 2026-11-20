import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from chat_context import fit_context, recent_images, validate_context_size


def message(role, text, image=None):
    return {"role": role, "content": text, **({"imagePath": image} if image else {})}


def measure(turns):
    return sum(len(turn["content"]) + (100 if turn.get("imagePath") else 0) for turn in turns)


class ChatContextTests(unittest.TestCase):
    def test_custom_context_uses_the_model_limit(self):
        self.assertEqual(validate_context_size(24576, 65536), 24576)
        self.assertEqual(validate_context_size(None, 6144), 6144)
        self.assertEqual(validate_context_size(None), 8192)
        for invalid in (True, 0, 2000.5, 65537):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "Context length"):
                validate_context_size(invalid, 65536)

    def test_compaction_keeps_system_and_recent_generated_image_and_reuses_memory(self):
        history = [
            message("system", "system instructions"),
            message("user", "Remember NIMBUS-417. " + "old instructions " * 80),
            message("assistant", "Got it."),
            message("user", "Build the teapot."),
            message("assistant", "I generated the teapot.", "teapot.png"),
            message("user", "What color is it?"),
        ]
        calls = []

        def summarize(transcript):
            calls.append(transcript)
            return "Project codename NIMBUS-417."

        result, memory = fit_context(history, measure, summarize, 850)
        self.assertEqual(memory.dropped, 2)
        self.assertIn("NIMBUS-417", calls[0])
        self.assertIn("system instructions", result[0]["content"])
        self.assertIn("NIMBUS-417", result[0]["content"])
        self.assertEqual(result[-2]["imagePath"], "teapot.png")
        self.assertEqual(result[1]["role"], "user")
        self.assertLessEqual(measure(result), 850)
        _, next_memory = fit_context(history, measure, summarize, 850, previous=memory)
        self.assertEqual(next_memory, memory)
        self.assertEqual(len(calls), 1)

    def test_only_keeps_recent_pixels_without_mutating_transcript(self):
        history = [message("user", str(index), f"{index}.png") for index in range(5)]
        result = recent_images(history)
        self.assertEqual([m.get("imagePath") for m in result], [None, None, None, "3.png", "4.png"])
        self.assertEqual(history[0]["imagePath"], "0.png")

    def test_reincluded_old_pixels_survive_compaction_without_duplicate_images(self):
        history = [message("user", "Preserve NIMBUS-417. " + "background " * 900),
                   message("assistant", "Red poster", "red.png")]
        for index in range(5):
            history.extend([message("user", f"Draft {index}"), message("assistant", "Notes")])
        history.extend([
            message("user", "Make blue"),
            message("assistant", "Blue circle", "blue.png"),
            message("user", "Make green"),
            message("assistant", "Green circle", "green.png"),
            message("user", "What was in the red poster?", "red.png"),
        ])
        visible = recent_images(history)
        self.assertEqual([turn["imagePath"] for turn in visible if turn.get("imagePath")], ["green.png", "red.png"])
        for budget in (4096, 8192, 16384):
            with self.subTest(budget=budget):
                prepared, memory = fit_context(visible, measure, lambda _: "Project code NIMBUS-417.", budget)
                self.assertEqual([turn["imagePath"] for turn in prepared if turn.get("imagePath")], ["green.png", "red.png"])
                self.assertIn("NIMBUS-417", prepared[0]["content"])
                self.assertEqual(memory is not None, budget < 12000)

    def test_reports_an_oversized_current_turn(self):
        history = [message("user", "Too big." * 140)]
        with self.assertRaisesRegex(ValueError, "larger context"):
            fit_context(history, measure, lambda _: "notes", 600)
