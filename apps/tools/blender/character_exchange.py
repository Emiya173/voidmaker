"""Blender-only adapter: PMX import, editable project, geometry-only glTF export.

Run through character:roundtrip in the locked character Nix shell. No user startup
file, add-on installation, material conversion, physics or pose evaluation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

import bpy


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--blend")
    parser.add_argument("--morph", action="append", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    output = Path(args.output)
    source = Path(args.source).resolve()
    fingerprint = hashlib.sha256(source.read_bytes()).hexdigest()
    sys.path.insert(0, os.environ["VOIDMAKER_MMD_TOOLS"])
    sys.path.insert(0, os.environ["VOIDMAKER_MMD_PYTHON"])
    import mmd_tools

    mmd_tools.register()
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=str(Path(args.blend).resolve()), load_ui=False, use_scripts=False)
        if bpy.context.scene.get("voidmaker_source_sha256") != fingerprint:
            raise RuntimeError("Blender project source fingerprint mismatch")
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.mmd_tools.import_model(
            filepath=str(source), scale=1.0, clean_model=False, remove_doubles=False,
            types={"MESH", "ARMATURE", "MORPHS"}, rename_bones=False,
            fix_bone_order=False, fix_ik_links=False, log_level="WARNING",
        )
        bpy.context.scene["voidmaker_source_sha256"] = fingerprint

    # Authoring rigs may be saved in Pose/Edit Mode. Flush edits before making
    # an isolated export copy; never evaluate the control rig or its drivers.
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.get("voidmaker_export", True)]
    snapshots = ("_PMX_ID", "_PMX_EDGE", "_VM_BASE_POSITION", "_VM_BASE_NORMAL")
    authored = [obj for obj in meshes if any(name in obj.data.attributes for name in snapshots)]
    candidates = authored if args.blend and authored else meshes
    if len(candidates) != 1:
        raise RuntimeError("Expected one PMX mesh; keep topology and edit vertex groups")
    obj = candidates[0]
    ignored_meshes = [other.name for other in meshes if other != obj]
    mesh = obj.data
    if any(m.type != "ARMATURE" and (m.show_viewport or m.show_render) for m in obj.modifiers):
        raise RuntimeError("Unapplied geometry modifiers are not supported by this topology-preserving exchange")
    if not args.blend:
        identity = mesh.attributes.new("_PMX_ID", "FLOAT", "POINT")
        identity.data.foreach_set("value", list(range(len(mesh.vertices))))
        edge = mesh.attributes.new("_PMX_EDGE", "FLOAT", "POINT")
        weights = obj.vertex_groups.get("mmd_edge_scale")
        edge.data.foreach_set("value", [weights.weight(i) for i in range(len(mesh.vertices))])
        # Keep an import snapshot. Blender quantizes custom normals and cannot retain
        # authored normals on collapsed expression triangles. Unedited corners travel
        # in an explicit float channel; edited neighborhoods use Blender's new normals.
        positions = mesh.attributes.new("_VM_BASE_POSITION", "FLOAT_VECTOR", "POINT")
        positions.data.foreach_set("vector", [n for v in mesh.vertices for n in v.co])
        normals = mesh.attributes.new("_VM_BASE_NORMAL", "FLOAT_VECTOR", "CORNER")
        normals.data.foreach_set("vector", [n for v in mesh.corner_normals for n in v.vector])
        # Groups expose material regions without separating/reordering the mesh.
        for index, material in enumerate(mesh.materials):
            ids = {v for face in mesh.polygons if face.material_index == index for v in face.vertices}
            if ids:
                group = obj.vertex_groups.new(name="edit:" + material.mmd_material.name_j)
                group.add(list(ids), 1.0, "REPLACE")
        for armature in (o for o in bpy.context.scene.objects if o.type == "ARMATURE"):
            armature.data.pose_position = "REST"
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.ops.wm.save_as_mainfile(filepath=str(output / "baseline.blend"))
    for name in snapshots:
        if name not in mesh.attributes:
            raise RuntimeError("Missing exchange snapshot; reimport the PMX: " + name)

    # Work on an export copy; keep all original morphs/bones in the editable .blend.
    copy = obj.copy()
    copy.data = mesh.copy()
    bpy.context.collection.objects.link(copy)
    matrix = obj.matrix_world.copy()
    copy.parent = None
    copy.matrix_world = matrix
    copy.modifiers.clear()
    copy.active_shape_key_index = 0
    copy.show_only_shape_key = False
    for key in list(copy.data.shape_keys.key_blocks)[1:]:
        if key.name not in args.morph:
            copy.shape_key_remove(key)
    names = [key.name for key in copy.data.shape_keys.key_blocks][1:]
    if set(names) != set(args.morph):
        raise RuntimeError("Required vertex morph not found")
    for key in copy.data.shape_keys.key_blocks:
        key.value = 0
    bpy.context.view_layer.update()
    from mmd_tools.core import pmx

    original = pmx.load(str(source))
    data = copy.data
    base_positions = data.attributes["_VM_BASE_POSITION"].data
    basis = data.shape_keys.key_blocks[0].data
    changed = {i for i, v in enumerate(basis) if (v.co - base_positions[i].vector).length > 1e-7}
    affected = set(changed)
    for face in data.polygons:
        if any(i in changed for i in face.vertices):
            affected.update(face.vertices)
    imported_normals = data.attributes["_VM_BASE_NORMAL"].data
    ids = data.attributes["_PMX_ID"].data
    transferred, preserved = [], 0
    for loop, normal in zip(data.loops, data.corner_normals):
        i = loop.vertex_index
        if i not in affected and (normal.vector - imported_normals[loop.index].vector).length < 1e-6:
            n = original.vertices[round(ids[i].value)].normal
            transferred.extend((n[0], n[1], -n[2]))  # PMX -> glTF; custom attributes are not axis-converted.
            preserved += 1
        else:
            n = normal.vector
            transferred.extend((n.x, n.z, -n.y))  # Blender -> glTF.
    transfer = data.attributes.new("_VM_NORMAL", "FLOAT_VECTOR", "CORNER")
    transfer.data.foreach_set("vector", transferred)
    for name in ("_VM_BASE_POSITION", "_VM_BASE_NORMAL"):
        data.attributes.remove(data.attributes[name])
    # Placeholder materials preserve identity; PMX toon parameters stay in the TS sidecar.
    for index, material in enumerate(list(copy.data.materials)):
        placeholder = bpy.data.materials.new("pmx_" + str(index))
        placeholder["voidmaker_material"] = material.mmd_material.name_j
        copy.data.materials[index] = placeholder
    bpy.ops.object.select_all(action="DESELECT")
    copy.select_set(True)
    bpy.context.view_layer.objects.active = copy
    bpy.ops.export_scene.gltf(
        filepath=str(output / "blender.gltf"), export_format="GLTF_SEPARATE",
        use_selection=True, export_yup=True, export_apply=False,
        export_texcoords=True, export_normals=True, export_tangents=False,
        export_attributes=True, export_extras=True, export_materials="EXPORT",
        export_animations=False, export_skins=False, export_morph=True,
        export_morph_normal=False, export_morph_tangent=False,
    )
    (output / "blender-toolchain.json").write_text(json.dumps({
        "blender": bpy.app.version_string, "mmdTools": mmd_tools.MMD_TOOLS_VERSION,
        "sourceSha256": fingerprint, "vertices": len(mesh.vertices),
        "adapterSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "binarySha256": hashlib.sha256((output / "blender.bin").read_bytes()).hexdigest(),
        "triangles": len(mesh.polygons), "morphs": names,
        "sourceMesh": obj.name, "ignoredSceneMeshes": ignored_meshes,
        "posePolicy": "raw mesh and morph data; strip armature modifiers on export copy; no animation or skin",
        "normalPolicy": "authored float normals on unchanged corners; Blender normals on edited neighborhoods",
        "preservedNormalCorners": preserved, "editedNormalCorners": len(data.loops) - preserved,
        "materialPolicy": "geometry-only; use original PMX toon/outline/texture sidecar",
    }, indent=2) + "\n", encoding="utf8")


if __name__ == "__main__":
    main()
