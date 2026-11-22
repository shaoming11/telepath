# Models

## airpods.glb

Classic stem AirPods (1st/2nd gen shape), earbuds only, no case.

- Source: `public/Airpods.glb` from the GitHub repo `foasho/r3f-wireless-earphones` (Blender glTF export, no author or licence metadata in the file). Re-oriented, re-centred, re-scaled, given new materials, and smoothed with two levels of Loop subdivision here so the silhouette holds in a close-up (about 151k triangles per bud, 747 KB on disk). Personal, non-commercial use.
- Compression: Draco (`KHR_draco_mesh_compression`), so the loader needs a `DRACOLoader` (drei's `useGLTF` sets one up by default). No textures.
- Top-level nodes: `AirPodLeft` and `AirPodRight`, one mesh each, no parent group. The two are mirror images of each other.
- Materials: `AirPodWhite` (glossy white, clearcoat), `SpeakerMesh` (dark grilles and sensor windows), `Chrome` (stem tip ring).
- Axes (each bud's local frame, node rotation is identity in the file): the stem points along -Y, tip at the bottom. The ear-facing side with the speaker grilles faces +Z. The smooth outer side faces -Z.
- Size: each bud is exactly 1.0 unit tall (y from -0.5 to +0.5), about 0.35 wide (x) and 0.42 deep (z). 1 unit is about 42 mm, so multiply by 0.042 for metres.
- Origin: the centre of each bud's own bounding box. The stem tip is at y = -0.5 and the top of the head at y = +0.5.
- Rest pose in the file: `AirPodLeft` at x = -0.42, `AirPodRight` at x = +0.42, both at y = 0, z = 0, no rotation. The pair spans about 1.19 x 1.0 x 0.43 units.
