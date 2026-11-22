# Models

The bundled classic model uses these conventions.

- Top-level nodes: `AirPodLeft` and `AirPodRight`, one mesh each, no parent group, no animations.
- Axes (each bud's local frame, node rotation is identity in the file): the stem points along -Y, tip at the bottom. The ear-facing side faces +Z, the outer side faces -Z.
- Size: each bud is exactly 1.0 unit tall (y from -0.5 to +0.5).
- Origin: the centre of each bud's own bounding box. The stem tip is at y = -0.5 and the top of the head at y = +0.5.
- Rest pose in the file: `AirPodLeft` at x = -0.42, `AirPodRight` at x = +0.42, both at y = 0, z = 0, no rotation.
- Compression: Draco (`KHR_draco_mesh_compression`), so the loader needs a `DRACOLoader` (drei's `useGLTF` sets one up by default). The white body uses `KHR_materials_clearcoat`.
- Texture: one 64x64 PNG, a tiling perforation pattern used as the base colour of `SpeakerMesh`. It needs repeat wrapping, which is the glTF default.

## airpods.glb

Classic stem AirPods (1st/2nd gen shape), earbuds only, no case. 767 KB.

- Source: `public/Airpods.glb` from the GitHub repo `foasho/r3f-wireless-earphones` (Blender glTF export, no author or licence metadata in the file). Re-oriented, re-centred, re-scaled, given new materials, and smoothed with two levels of Loop subdivision here so the silhouette holds in a close-up (about 151k triangles per bud). Personal, non-commercial use.
- Materials: `AirPodWhite` (glossy white, clearcoat), `SpeakerMesh` (dark perforated grilles and sensor windows), `Chrome` (stem tip ring).
- Size: each bud is 1.0 tall, about 0.35 wide (x) and 0.42 deep (z). 1 unit is about 42 mm, so multiply by 0.042 for metres. The pair spans about 1.19 x 1.0 x 0.43 units.
- The two buds are mirror images of each other. The speaker grilles are on the +Z side.
