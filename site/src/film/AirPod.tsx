import { forwardRef } from "react";
import type { Group } from "three";

// Procedural stand-in for the earbud model. Origin is the centre of the head; the stem points down -Y.
export const AirPod = forwardRef<Group, { side: 1 | -1 }>(function AirPod({ side }, ref) {
  const shell = (
    <meshPhysicalMaterial color="#f3f3f1" roughness={0.22} metalness={0} clearcoat={1} clearcoatRoughness={0.12} sheen={0.4} sheenColor="#ffffff" />
  );
  return (
    <group ref={ref}>
      <mesh scale={[1, 0.93, 0.86]}>
        <sphereGeometry args={[0.62, 96, 96]} />
        {shell}
      </mesh>
      <mesh position={[0.3 * side, -0.14, 0.26]} rotation={[0.3, 0.5 * side, 0]} scale={[1, 0.86, 0.9]}>
        <sphereGeometry args={[0.43, 64, 64]} />
        {shell}
      </mesh>
      <mesh position={[-0.14 * side, -1.3, -0.1]} rotation={[0.07, 0, 0.07 * side]}>
        <capsuleGeometry args={[0.185, 1.95, 24, 48]} />
        {shell}
      </mesh>
      <mesh position={[-0.21 * side, -2.44, -0.17]} rotation={[0.07, 0, 0.07 * side]}>
        <cylinderGeometry args={[0.186, 0.17, 0.09, 48]} />
        <meshStandardMaterial color="#d9dadc" metalness={1} roughness={0.18} />
      </mesh>
      <mesh position={[0.58 * side, -0.2, 0.5]} rotation={[0.3, 0.9 * side, 0]} scale={[1, 0.62, 0.18]}>
        <sphereGeometry args={[0.17, 32, 32]} />
        <meshStandardMaterial color="#101012" metalness={0.6} roughness={0.55} />
      </mesh>
      <mesh position={[-0.36 * side, 0.3, -0.36]} rotation={[-0.5, -0.8 * side, 0]} scale={[1, 0.4, 0.14]}>
        <sphereGeometry args={[0.13, 32, 32]} />
        <meshStandardMaterial color="#101012" metalness={0.6} roughness={0.55} />
      </mesh>
    </group>
  );
});
