from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from chat_image_tools import CHAT_IMAGE_SIZE, image_tool_prompt


class ChatImageToolTests(unittest.TestCase):
    def call(self, name="generate_image", **args):
        return [{"id": "call", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]

    def test_chat_has_a_fixed_render_size(self):
        self.assertEqual(CHAT_IMAGE_SIZE, 512)
        self.assertEqual(image_tool_prompt(self.call(prompt="  Red teapot  ")), "Red teapot")

    def test_rejects_multiple_unknown_or_oversized_calls(self):
        for calls in (self.call(name="run_command", prompt="text"),
                      self.call(prompt="Image") * 2,
                      self.call(prompt="x" * 2001),
                      self.call(prompt="Image", width=1920),
                      self.call(prompt="Image", size="1920x1920")):
            with self.subTest(calls=calls), self.assertRaises(ValueError):
                image_tool_prompt(calls)

    def test_rejects_incomplete_calls(self):
        calls = self.call(prompt="teapot")
        calls[0]["function"]["arguments"] = '{"prompt":'
        with self.assertRaises(ValueError):
            image_tool_prompt(calls)
