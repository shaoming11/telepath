import { forwardRef, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import type { Group, Mesh, MeshPhysicalMaterial } from "three";

const MODEL = "/models/airpods.glb";
const DRACO = "/draco/";
const HEIGHT = 2.7;
const HEAD_CENTRE = 0.3;

// Origin is the centre of the head; the stem points down -Y. `side` 1 is the left earbud, -1 the right.
export const AirPod = forwardRef<Group, { side: 1 | -1 }>(function AirPod({ side }, ref) {
  const { nodes } = useGLTF(MODEL, DRACO);
  const source = nodes[side === 1 ? "AirPodLeft" : "AirPodRight"] as Mesh;
  const mesh = useMemo(() => {
    const copy = source.clone();
    copy.position.set(0, -HEAD_CENTRE * HEIGHT, 0);
    copy.rotation.set(0, 0, 0);
    copy.scale.setScalar(HEIGHT);
    copy.traverse(node => {
      const material = (node as Mesh).material as MeshPhysicalMaterial | undefined;
      if (material?.name !== "AirPodWhite") return;
      material.color.set("#ffffff");
      material.roughness = 0.2;
      material.clearcoat = 1;
      material.clearcoatRoughness = 0.08;
    });
    return copy;
  }, [source]);
  return (
    <group ref={ref}>
      <primitive object={mesh} />
    </group>
  );
});

useGLTF.preload(MODEL, DRACO);
