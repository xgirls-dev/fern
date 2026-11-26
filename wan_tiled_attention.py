"""Keep global Wan attention while bounding the number of queries processed together."""

import argparse

import numpy as np
import openvino as ov
from openvino import opset13 as op


def tiled_attention(query, key, value, tile):
    shape = list(query.get_shape())
    if list(key.get_shape()) != shape or list(value.get_shape()) != shape or shape[2] % tile:
        raise ValueError("Expected equal, evenly tiled self-attention inputs.")
    tiles = shape[2] // tile
    split_query = op.reshape(query, op.constant(np.int64([*shape[:2], tiles, tile, shape[3]])), False)
    query_tile = op.parameter([*shape[:2], 1, tile, shape[3]], query.get_element_type())
    all_keys = op.parameter(shape, key.get_element_type())
    all_values = op.parameter(shape, value.get_element_type())
    axis = op.constant(np.int64([2]))
    attention = op.scaled_dot_product_attention(op.squeeze(query_tile, axis), all_keys, all_values, causal=False)
    attention_tile = op.unsqueeze(attention, axis)
    keep_running = op.constant(np.bool_(True))
    body = ov.Model([attention_tile, keep_running], [query_tile, all_keys, all_values])

    loop = op.loop(op.constant(np.int64(tiles)), keep_running)
    loop.set_function(body)
    loop.set_special_body_ports([-1, 1])
    loop.set_sliced_input(query_tile, split_query.output(0), 0, 1, 1, -1, 2)
    loop.set_invariant_input(all_keys, key)
    loop.set_invariant_input(all_values, value)
    joined = loop.get_concatenated_slices(attention_tile.output(0), 0, 1, 1, -1, 2)
    return op.reshape(joined, op.constant(np.int64(shape)), False).output(0)


def make_transformer(core, xml_path, frames, height, width):
    model = core.read_model(xml_path)
    latent_frames = (frames - 1) // 4 + 1
    # One sequence tile covers the spatial patches of one latent frame.
    tile = height // 32 * (width // 32)
    model.reshape({
        "hidden_states": [1, 48, latent_frames, height // 16, width // 16],
        "timestep": [1, latent_frames * tile],
        "encoder_hidden_states": [1, 512, 4096],
    })
    replaced = 0
    for node in model.get_ordered_ops():
        if node.get_type_name() != "ScaledDotProductAttention" or ".attn1/" not in node.get_friendly_name():
            continue
        if node.get_input_size() != 3 or node.get_attributes()["causal"]:
            raise ValueError("The pinned transformer contains unsupported self-attention.")
        output = tiled_attention(*node.input_values(), tile)
        output.get_node().set_friendly_name(node.get_friendly_name())
        node.output(0).replace(output)
        replaced += 1
    if replaced != 30:
        raise ValueError(f"Expected to tile 30 self-attention layers, found {replaced}.")
    model.validate_nodes_and_infer_types()
    return model


def verify_tiled_attention(core):
    inputs = [op.parameter([2, 4, 12, 8], ov.Type.f32) for _ in range(3)]
    untiled = op.scaled_dot_product_attention(*inputs, causal=False)
    tiled = tiled_attention(*(node.output(0) for node in inputs), 4)
    source = ov.Model([untiled.output(0), tiled], inputs)
    run = core.compile_model(source, "CPU", {"INFERENCE_PRECISION_HINT": "f32"})
    random = np.random.default_rng(91)
    tensors = [random.normal(size=(2, 4, 12, 8)).astype(np.float32) for _ in range(3)]
    result = run(tensors)
    np.testing.assert_allclose(result[run.output(0)], result[run.output(1)], rtol=1e-5, atol=1e-6)
    maximum_error = np.abs(result[run.output(0)] - result[run.output(1)]).max()
    print(f"Global attention matches with tiled queries (maximum absolute error {maximum_error:.3g}).", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--transformer")
    args = parser.parse_args()
    core = ov.Core()
    verify_tiled_attention(core)
    if args.transformer:
        model = make_transformer(core, args.transformer, 161, 704, 544)
        assert model.output().get_shape() == ov.Shape([1, 48, 41, 44, 34])
        print("All 30 self-attention layers tiled in the pinned 161-frame transformer graph.", flush=True)
