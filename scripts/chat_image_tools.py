"""The image-generation tool exposed to local chat models."""
from __future__ import annotations

import json
from typing import Any


CHAT_IMAGE_SIZE = 512
IMAGE_MODEL_PRIORITY = ("sana-sprint", "moss-hades", "z-image-turbo", "4b", "4b-lora", "9b", "9b-lora", "kromoss-opd-dmd2")
IMAGE_TOOL = {
    "type": "function",
    "function": {
        "name": "generate_image",
        "description": (
            "Create an image and attach it to this chat. Call this when the user asks to make a picture, "
            "illustration, or other visual. Apply details established earlier in the conversation. "
            "Answer normally when the user is discussing an image or asks for a text response."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "A concrete, self-contained visual description of the image."},
            },
            "required": ["prompt"],
            "additionalProperties": False,
        },
    },
}


def image_tool_prompt(calls: list[dict[str, Any]]) -> str:
    if len(calls) != 1 or calls[0].get("type") != "function":
        raise ValueError("Chat can generate one image per response. Try asking for one image.")
    function = calls[0]["function"]
    if function.get("name") != IMAGE_TOOL["function"]["name"]:
        raise ValueError("The chat model requested an unavailable tool.")
    try:
        args = json.loads(function["arguments"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("The chat model sent incomplete image instructions. Retry the response.") from error
    if not isinstance(args, dict) or set(args) - {"prompt"}:
        raise ValueError("The chat model sent unsupported image instructions.")
    prompt = args.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 2000:
        raise ValueError("The image description must contain between 1 and 2,000 characters.")
    return prompt.strip()
