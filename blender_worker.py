import json
from pathlib import Path
import sys
import bpy
from mathutils import Matrix, Vector


def progress(value, message):
    print("PROGRESS " + json.dumps(dict(progress=value, message=message)), flush=True)


def bounds(obj):
    return (Vector([min(p[i] for p in obj.bound_box) for i in range(3)]),
            Vector([max(p[i] for p in obj.bound_box) for i in range(3)]))


def inspect(scene, objects):
    items = []
    for obj in objects:
        lo, hi = bounds(obj)
        units = scene.unit_settings.scale_length * 100 if scene.unit_settings.system != "NONE" else 100
        size = [(hi[i] - lo[i]) * obj.matrix_world.to_3x3().col[i].length * units for i in range(3)]
        cube = len(obj.data.vertices) == 8 and len(obj.data.polygons) in (6, 12)
        hint = any(word in obj.name.lower() for word in ("box", "cube", "block", "stock"))
        score = 20 * cube + 10 * hint + 5 * (obj.display_type == "WIRE")
        items.append(dict(id=obj.name, name=obj.name, type="MESH", dimensions=size,
            visible=obj.visible_get(), hideRender=obj.hide_render, isBoxCandidate=cube or hint,
            suggestedBox=False, score=score))
    candidates = [item for item in items if item["isBoxCandidate"]]
    chosen = max(candidates, key=lambda item: item["score"]) if candidates else None
    if chosen:
        chosen["suggestedBox"] = True
    for item in items:
        del item["score"]
    return dict(objects=items, suggestedBox=chosen["id"] if chosen else None,
                suggestedBoxSizeCm=chosen["dimensions"] if chosen else None)


def export(request, objects):
    by_name = {obj.name: obj for obj in objects}
    box = by_name[request["boxObject"]]
    selected = request.get("modelObjects")
    objects = ([by_name[name] for name in dict.fromkeys(selected)] if selected is not None else
               [obj for obj in objects if obj != box and obj.visible_get() and not obj.hide_render])
    if not objects:
        raise ValueError("Select at least one model object.")
    lo, hi = bounds(box)
    size = request["boxSizeCm"]
    if min(hi - lo) <= 1e-9 or abs(box.matrix_world.determinant()) <= 1e-15:
        raise ValueError("The box must have nonzero width, depth, and height.")
    transform = (Matrix.Diagonal(Vector([size[i] / (hi[i] - lo[i]) for i in range(3)] + [1])) @
                 Matrix.Translation(-(lo + hi) * 0.5) @ box.matrix_world.inverted())
    images = {node.image for obj in objects for material in obj.data.materials
              if material and material.use_nodes for node in material.node_tree.nodes
              if node.type == "TEX_IMAGE" and node.image}
    warnings = [f'Texture "{image.name}" is missing. Pack Resources in Blender, save, and import again.'
                for image in images if image.source == "FILE" and not image.packed_file
                and not Path(bpy.path.abspath(image.filepath)).is_file()]
    progress(30, "Preparing model and textures...")
    depsgraph = bpy.context.evaluated_depsgraph_get()
    scene = bpy.data.scenes.new("Export")
    scene.unit_settings.system = "NONE"
    scene.unit_settings.scale_length = 1
    outside, count = False, 0
    for obj in objects:
        mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph),
                                               preserve_all_data_layers=True, depsgraph=depsgraph)
        matrix = transform @ obj.matrix_world
        mesh.transform(matrix)
        if matrix.determinant() < 0:
            mesh.flip_normals()
        mesh.update()
        clone = bpy.data.objects.new(obj.name, mesh)
        clone["sourceObject"] = obj.name
        scene.collection.objects.link(clone)
        count += len(mesh.vertices)
        outside |= any(abs(vertex.co[i]) > size[i] / 2 + 0.005
                       for vertex in mesh.vertices for i in range(3))
    if not count:
        raise ValueError("The selected meshes contain no vertices.")
    if outside:
        warnings.append("Part of the model extends outside the box.")
    bpy.context.window.scene = scene
    progress(70, "Exporting textured model...")
    bpy.ops.export_scene.gltf(filepath=request["exportPath"], export_format="GLB",
        use_active_scene=True, use_selection=False, use_visible=False, use_renderable=False,
        export_yup=True, export_apply=False, export_animations=False, export_cameras=False,
        export_lights=False, export_extras=True, export_materials="EXPORT", export_image_format="AUTO")
    if not Path(request["exportPath"]).is_file():
        raise ValueError("Blender did not create a model file.")
    return dict(boxSizeCm=size, boxObject=box.name, modelObjects=[obj.name for obj in objects],
                coordinateUnit="cm", warnings=warnings)


def main():
    request = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text(encoding="utf-8"))
    try:
        bpy.ops.wm.open_mainfile(filepath=request["input"], load_ui=False, use_scripts=False)
        if bpy.context.object and bpy.context.object.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        bpy.context.view_layer.update()
        progress(15, "Reading scene...")
        scene = bpy.context.scene
        objects = [obj for obj in scene.objects if obj.type == "MESH"]
        if not objects:
            raise ValueError("This scene contains no mesh objects.")
        result = inspect(scene, objects) if request["operation"] == "inspect" else export(request, objects)
    except Exception as error:
        result = {"error": str(error)}
    Path(request["output"]).write_text(json.dumps(result), encoding="utf-8")


if __name__ == "__main__":
    main()
