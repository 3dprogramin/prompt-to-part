# Builds a .blend from prompt-to-part meshes. Run headless:
#   blender -b --factory-startup --python blender_export.py -- <input_dir> <output.blend>
import json
import math
import os
import sys

import bpy
import numpy as np

src, out = sys.argv[sys.argv.index("--") + 1:][:2]
man = json.load(open(os.path.join(src, "manifest.json"), encoding="utf-8"))

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.unit_settings.scale_length = 0.001  # 1 Blender unit = 1 mm
scene.unit_settings.length_unit = "MILLIMETERS"


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_color(h, alpha=1.0):
    h = h.lstrip("#")
    if len(h) != 6:
        h = "c9a26b"
    rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(srgb_to_linear(c) for c in rgb) + (alpha,)


def make_material(name, color, emission=False):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Roughness"].default_value = 0.55
        if emission:
            bsdf.inputs["Emission Color"].default_value = color
            bsdf.inputs["Emission Strength"].default_value = 1.0
    return mat


root = bpy.data.collections.new(man["name"])
scene.collection.children.link(root)
parts_col = bpy.data.collections.new("Parts")
root.children.link(parts_col)

for p in man["parts"]:
    pos = np.fromfile(os.path.join(src, p["positions"]), dtype="<f4")
    idx = np.fromfile(os.path.join(src, p["indices"]), dtype="<u4").astype(np.int32)
    nv, nt = len(pos) // 3, len(idx) // 3
    me = bpy.data.meshes.new(p["name"])
    me.vertices.add(nv)
    me.vertices.foreach_set("co", pos)
    me.loops.add(nt * 3)
    me.loops.foreach_set("vertex_index", idx)
    me.polygons.add(nt)
    me.polygons.foreach_set("loop_start", np.arange(0, nt * 3, 3, dtype=np.int32))
    me.update(calc_edges=True)
    me.validate()
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(30))
    me.materials.append(make_material(p["name"], hex_color(p["color"])))
    ob = bpy.data.objects.new(p["name"], me)
    parts_col.objects.link(ob)
    for k, v in man.get("params", {}).items():
        try:
            ob[k] = v
        except Exception:
            pass

# Dimension callouts: line + arrow ticks + a text label, in their own collection.
dims = man.get("dimensions", [])
if dims:
    dim_col = bpy.data.collections.new("Dimensions")
    root.children.link(dim_col)
    size = max(man.get("size", 100), 1)
    text_size = size * 0.035
    for i, d in enumerate(dims):
        a = np.array(d["from"], dtype=float) + np.array(d.get("offset", [0, 0, 0]), dtype=float)
        b = np.array(d["to"], dtype=float) + np.array(d.get("offset", [0, 0, 0]), dtype=float)
        verts = [tuple(d["from"]), tuple(a), tuple(b), tuple(d["to"])]
        edges = [(0, 1), (1, 2), (2, 3)] if d.get("offset") else [(1, 2)]
        lm = bpy.data.meshes.new(f"dim_{i}")
        lm.from_pydata(verts, edges, [])
        color = hex_color(d.get("color", "#f0b54a"))
        lm.materials.append(make_material(f"dim_{i}", color, emission=True))
        lo = bpy.data.objects.new(f"Dim {d['label']}", lm)
        dim_col.objects.link(lo)

        cu = bpy.data.curves.new(f"label_{i}", type="FONT")
        cu.body = d["label"]
        cu.size = text_size
        cu.align_x = "CENTER"
        cu.align_y = "BOTTOM"
        cu.materials.append(make_material(f"label_{i}", color, emission=True))
        to = bpy.data.objects.new(f"Label {d['label']}", cu)
        mid = (a + b) / 2
        to.location = tuple(mid)
        direction = b - a
        if abs(direction[2]) > max(abs(direction[0]), abs(direction[1])):
            to.rotation_euler = (math.radians(90), 0, 0)  # stand up, readable from the front
        else:
            to.rotation_euler = (0, 0, math.atan2(direction[1], direction[0]))
        dim_col.objects.link(to)

# Keep the parametric source with the file.
if man.get("code"):
    txt = bpy.data.texts.new("model.js")
    txt.write(man["code"])
info = bpy.data.texts.new("prompt-to-part.txt")
info.write(json.dumps({"name": man["name"], "parameters": man.get("params", {})}, indent=2, ensure_ascii=False))

bpy.ops.wm.save_as_mainfile(filepath=out, compress=True)
print("SAVED", out)
