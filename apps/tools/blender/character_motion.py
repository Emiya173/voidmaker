"""Export evaluated deformation bones and face-only targets without saving Blender.

blender --background --factory-startup --disable-autoexec --python-exit-code 1
  --python apps/tools/blender/character_motion.py -- --blend SOURCE.blend
  --pmx model.pmx --map vertex-map.json --author LOCAL_RECIPE.py --output NEW_DIR

The trusted local author module supplies Author(mesh, rig, source), CLIPS, and
neutral(), sample(name, seconds), expression(name). Its sample returns a facial
weight. Constraints and IK are evaluated offline; Qt only needs local TR tracks.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys

import addon_utils
import bpy
import numpy as np
from mathutils import Matrix


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def coordinates(data, attribute):
    values = np.empty(len(data) * 3, dtype=np.float32)
    data.foreach_get(attribute, values)
    return values.reshape(-1, 3)


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n')


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('blend', 'pmx', 'map', 'author', 'output'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--rig', default='Chiaki_ARP')
    parser.add_argument('--source', default='nanami_ver1.0.1_arm')
    parser.add_argument('--fps', type=int, default=30)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    if not 10 <= args.fps <= 60:
        raise ValueError('Sampling rate must be between 10 and 60 FPS')
    inputs = {name: Path(getattr(args, name)).resolve(strict=True) for name in ('blend', 'pmx', 'map', 'author')}
    fingerprints = {name: digest(path) for name, path in inputs.items()}
    out = Path(args.output).resolve()
    staging = out.with_name(out.name + '.partial')
    if out.exists() or staging.exists():
        raise FileExistsError('Choose a new output directory: ' + str(out))
    export_report = json.loads((inputs['map'].parent / 'export-report.json').read_text())
    assert export_report['blendSha256'] == fingerprints['blend'], 'Map/blend revision mismatch'
    assert export_report['candidateSha256'] == fingerprints['pmx'], 'Map/PMX revision mismatch'
    mapping = json.loads(inputs['map'].read_text())
    addon_utils.enable('auto_rig_pro', default_set=True)
    sys.path[:0] = [os.environ['VOIDMAKER_MMD_TOOLS'], os.environ['VOIDMAKER_MMD_PYTHON']]
    import mmd_tools
    mmd_tools.register()
    from mmd_tools.core import pmx
    model = pmx.load(str(inputs['pmx']))
    assert len(model.vertices) == len(mapping)
    bpy.ops.wm.open_mainfile(filepath=str(inputs['blend']), load_ui=False, use_scripts=False)
    objects = [o for o in bpy.context.scene.objects if o.type == 'MESH' and '_PMX_ID' in o.data.attributes]
    assert len(objects) == 1, 'Expected one mapped mesh'
    obj = objects[0]
    mesh = obj.data
    rig, source = bpy.data.objects[args.rig], bpy.data.objects[args.source]
    for item in (obj, source):
        assert max(abs(item.matrix_world[r][c] - (1 if r == c else 0)) for r in range(4) for c in range(4)) < 1e-6, 'Nonidentity source object transform'
    modifiers = [m for m in obj.modifiers if m.show_viewport]
    assert len(modifiers) == 1 and modifiers[0].type == 'ARMATURE' and modifiers[0].object == source
    assert not modifiers[0].use_deform_preserve_volume, 'Dual quaternion skinning is not an LBS bind'
    vi = np.array([row['vertexIndex'] for row in mapping], dtype=np.int32)
    li = np.array([row['loopIndex'] for row in mapping], dtype=np.int32)
    assert vi.min() >= 0 and vi.max() < len(mesh.vertices)
    assert li.min() >= 0 and li.max() < len(mesh.loops)
    assert np.array_equal(np.array([loop.vertex_index for loop in mesh.loops])[li], vi)
    base = coordinates(mesh.shape_keys.key_blocks[0].data, 'co')
    source_positions = np.array([v.co[:] for v in model.vertices])
    assert np.abs(base[vi][:, [0, 2, 1]] - source_positions).max() < 3e-6
    shape_hashes = {key.name: hashlib.sha256(coordinates(key.data, 'co').tobytes()).hexdigest() for key in mesh.shape_keys.key_blocks}
    groups = {g.index: g.name for g in obj.vertex_groups}
    weighted = {groups[g.group] for v in mesh.vertices for g in v.groups if g.weight > 0 and groups[g.group] in source.data.bones and source.data.bones[groups[g.group]].use_deform}
    needed = set(weighted)
    for name in list(needed):
        parent = source.data.bones[name].parent
        while parent:
            needed.add(parent.name)
            parent = parent.parent
    names = []

    def add(name):
        if name in names:
            return
        parent = source.data.bones[name].parent
        if parent and parent.name in needed:
            add(parent.name)
        names.append(name)

    for bone in source.data.bones:
        if bone.name in needed:
            add(bone.name)
    assert len(names) + 1 <= 256
    indices = {name: i + 1 for i, name in enumerate(names)}
    parents = [0 if not source.data.bones[name].parent else indices[source.data.bones[name].parent.name] for name in names]
    axes = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
    axes_inverse = axes.inverted()
    spec = importlib.util.spec_from_file_location('local_motion_author', inputs['author'])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    author = module.Author(obj, rig, source)
    source.data.pose_position = 'POSE'
    author.neutral()
    max_scale_error = 0.0

    def transforms():
        nonlocal max_scale_error
        rig.update_tag()
        source.update_tag()
        bpy.context.view_layer.update()
        world = [Matrix.Identity(4)] + [axes @ source.pose.bones[name].matrix @ axes_inverse for name in names]
        result = [([0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0])]
        for index, parent in enumerate(parents, 1):
            local = world[parent].inverted() @ world[index]
            translation, rotation, scale = local.decompose()
            scale_error = max(abs(v - 1) for v in scale)
            max_scale_error = max(max_scale_error, scale_error)
            assert scale_error < 1e-4, ('Nonrigid deform bone', names[index - 1], list(scale))
            rotation.normalize()
            reconstructed = Matrix.LocRotScale(translation, rotation, None)
            assert max(abs(local[r][c] - reconstructed[r][c]) for r in range(4) for c in range(4)) < 1e-4, 'Sheared bone'
            result.append(([round(v, 7) for v in translation], [round(v, 8) for v in rotation]))
        return result

    neutral = transforms()
    joints = [{'name': '__voidmaker_root', 'parent': -1, 'translation': neutral[0][0], 'rotation': neutral[0][1], 'inverseBind': [int(r == c) for r in range(4) for c in range(4)]}]
    for index, name in enumerate(names, 1):
        inverse = axes @ source.data.bones[name].matrix_local.inverted() @ axes_inverse
        joints.append({'name': name, 'parent': parents[index - 1], 'translation': neutral[index][0], 'rotation': neutral[index][1], 'inverseBind': [round(v, 9) for row in inverse for v in row]})
    staging.mkdir(parents=True)
    report = {'version': 1, 'inputs': fingerprints, 'paths': {name: str(path) for name, path in inputs.items()}, 'exporterSha256': digest(__file__), 'blender': bpy.app.version_string, 'fps': args.fps, 'weightedBones': len(weighted), 'joints': len(joints), 'vertices': len(mapping), 'clips': {}, 'faces': {}}
    clips = []
    for name, duration in module.CLIPS.items():
        assert name in ('yawn', 'think', 'greet') and 0 < duration <= 60
        times = sorted({round(i * duration / math.ceil(duration * args.fps), 7) for i in range(math.ceil(duration * args.fps) + 1)} | {0.0, duration, round(duration * .34, 7), round(duration * .66, 7)})
        samples, expression = [], []
        for time in times:
            weight = float(author.sample(name, time))
            sample = transforms()
            if time in (0.0, duration):
                assert max(abs(a - b) for current, start in zip(sample, neutral) for av, bv in zip(current, start) for a, b in zip(av, bv)) < 1e-4, 'Action did not return to neutral'
                sample = [(list(t), list(q)) for t, q in neutral]
                weight = 0.0
            if samples:
                for index, (_, rotation) in enumerate(sample):
                    if sum(a * b for a, b in zip(rotation, samples[-1][index][1])) < 0:
                        sample[index] = (sample[index][0], [-v for v in rotation])
            samples.append(sample)
            expression.append({'time': time, 'weight': round(weight, 7)})
        tracks = []
        for index in range(len(joints)):
            track = {'joint': index, 'times': times}
            for key, component in [('translations', 0), ('rotations', 1)]:
                values = [sample[index][component] for sample in samples]
                if max(abs(a - b) for value in values for a, b in zip(value, neutral[index][component])) > 2e-6:
                    track[key] = values
            if len(track) > 2:
                tracks.append(track)
        write_json(staging / (name + '.json'), {'version': 1, 'duration': duration, 'tracks': tracks, 'expression': expression})
        clips.append({'name': name, 'file': name + '.json', 'duration': duration})
        # Diagnostic maximum local rotation step detects discontinuous elbow or
        # wrist branches. Hold endpoints retain the accepted authored posture.
        angular_steps = []
        for before, after in zip(samples, samples[1:]):
            for index, (a, b) in enumerate(zip(before, after)):
                dot = min(1.0, abs(sum(x * y for x, y in zip(a[1], b[1]))))
                angular_steps.append((math.degrees(2 * math.acos(dot)), joints[index]['name']))
        report['clips'][name] = {'duration': duration, 'samples': len(samples), 'tracks': len(tracks), 'sha256': digest(staging / (name + '.json')), 'maximumLocalRotationStep': max(angular_steps)}
        print('EXPORTED_MOTION', name, report['clips'][name], flush=True)
    write_json(staging / 'rig.json', {'version': 1, 'sourceSha256': fingerprints['pmx'], 'joints': joints, 'clips': clips})
    for name in module.CLIPS:
        author.expression(name)
        obj.update_tag()
        bpy.context.view_layer.update()
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).data
        assert len(evaluated.vertices) == len(mesh.vertices) and len(evaluated.loops) == len(mesh.loops)
        positions = coordinates(evaluated.vertices, 'co')[vi][:, [0, 2, 1]]
        normals = coordinates(evaluated.corner_normals, 'vector')[li][:, [0, 2, 1]]
        positions[:, 2] *= -1
        normals[:, 2] *= -1
        lengths = np.linalg.norm(normals, axis=1)
        valid = lengths > 1e-6
        normals[valid] /= lengths[valid, None]
        target = staging / ('face-' + name + '.json')
        write_json(target, {'sourceSha256': fingerprints['pmx'], 'positions': positions.tolist(), 'normals': normals.tolist()})
        report['faces'][name] = {'sha256': digest(target), 'space': 'original bind; expression only; no bone deformation'}
    source.data.pose_position = 'POSE'
    author.neutral()
    assert transforms() == neutral, 'Final neutral reset mismatch'
    assert all(hashlib.sha256(coordinates(mesh.shape_keys.key_blocks[name].data, 'co').tobytes()).hexdigest() == value for name, value in shape_hashes.items()), 'Existing shape key edited'
    assert all(digest(path) == fingerprints[name] for name, path in inputs.items()), 'Input file changed'
    report.update(maximumScaleError=max_scale_error, inputsUnchanged=True, blendWritten=False, neutralResetExact=True)
    write_json(staging / 'export-report.json', report)
    staging.rename(out)
    print('EXPORTED_ALL_MOTIONS', out, flush=True)


if __name__ == '__main__':
    run()
