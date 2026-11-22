import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Environment, Html, Lightformer } from "@react-three/drei";
import { Bloom, EffectComposer, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshBasicMaterial, PerspectiveCamera,
  PointLight, Points, ShaderMaterial, TubeGeometry, Vector3,
} from "three";
import { AirPod } from "./AirPod";
import {
  A_POS, B_POS, PULSES, REVEAL_START, REVEAL_Y, SEAT_A, SEAT_B, TAPS, cameraAt, clamp01, easeInOut, easeOut, ramp, span,
} from "./choreo";
import { pulseMaterial } from "./pulse";

const HDR = 3.2;

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const REVEAL_PULSES = PULSES.filter(pulse => pulse.inReveal);

export function Scene({ clock, onTime }: { clock: { current: number }; onTime: (t: number) => void }) {
  const camera = useThree(state => state.camera) as PerspectiveCamera;
  const size = useThree(state => state.size);
  const budA = useRef<Group>(null);
  const budB = useRef<Group>(null);
  const lightA = useRef<PointLight>(null);
  const lightB = useRef<PointLight>(null);
  const dust = useRef<Points>(null);
  const tubes = useRef<(Mesh | null)[]>([]);
  const heads = useRef<(Mesh | null)[]>([]);
  const labels = useRef<(HTMLDivElement | null)[]>([]);
  const rings = useRef<(Mesh | null)[]>([]);
  const dots = useRef<(Mesh | null)[]>([]);
  const hold = useRef<Mesh>(null);
  const look = useMemo(() => new Vector3(), []);
  const point = useMemo(() => new Vector3(), []);

  const pulses = useMemo(() => PULSES.map(pulse => ({
    ...pulse,
    geometry: new TubeGeometry(pulse.curve, 180, 0.02, 10, false),
    material: pulseMaterial(pulse.color),
    headMaterial: new MeshBasicMaterial({ color: new Color(pulse.color).multiplyScalar(HDR * 1.6), toneMapped: false, transparent: true, blending: AdditiveBlending, depthWrite: false }),
    anchor: pulse.label?.at === "apex" ? pulse.curve.getPoint(0.5).add(new Vector3(0, 0.3, 0))
      : pulse.label?.at === "A" ? new Vector3(-1.75, 0.75, 0.4)
      : new Vector3(2.05, 0.35, 0.6),
  })), []);

  const dustGeometry = useMemo(() => {
    const random = seeded(7);
    const positions = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i += 1) {
      positions[i * 3] = (random() - 0.5) * 22;
      positions[i * 3 + 1] = (random() - 0.5) * 10;
      positions[i * 3 + 2] = (random() - 0.5) * 12 - 1;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    return geometry;
  }, []);

  useFrame(() => {
    const t = clock.current;
    cameraAt(t, size.width / size.height, camera.position, look);
    camera.lookAt(look);

    const reveal = easeInOut(ramp(t, REVEAL_START + 1.8, REVEAL_START + 3.8));
    let flareA = 0;
    let flareB = 0;

    pulses.forEach((pulse, i) => {
      const travel = easeInOut(ramp(t, pulse.launch, pulse.land));
      const alive = t >= pulse.launch ? 1 - ramp(t, pulse.fade - 0.8, pulse.fade) : 0;
      const landed = t >= pulse.land ? Math.exp(-(t - pulse.land) * 1.4) : 0;
      const flying = t >= pulse.launch && t < pulse.land ? 1 : landed;
      const back = pulse.inReveal ? ramp(t, REVEAL_START + 0.3, REVEAL_START + 1.5) : 0;
      const uniforms = (pulse.material as ShaderMaterial).uniforms;
      uniforms.uHead.value = back > 0 ? 1.2 : travel * 1.04;
      uniforms.uGain.value = back > 0 ? 0 : HDR * flying * alive;
      uniforms.uTrace.value = back > 0 ? back * 0.55 : 0.2 * alive * ramp(t, pulse.launch, pulse.launch + 0.2);
      const tube = tubes.current[i];
      if (tube) {
        const flat = pulse.inReveal ? 1 - reveal * 0.985 : 1;
        tube.scale.y = flat;
        tube.position.y = REVEAL_Y * (1 - flat);
        tube.visible = alive > 0 || back > 0;
      }
      const head = heads.current[i];
      if (head) {
        pulse.curve.getPoint(clamp01(travel), point);
        head.position.copy(point);
        const glow = t >= pulse.launch && back === 0 ? (t < pulse.land ? 1 : landed) : 0;
        head.visible = glow > 0.01;
        head.scale.setScalar(0.6 + glow * 0.6 + landed * 1.4);
        (head.material as MeshBasicMaterial).opacity = glow;
      }
      const target = pulse.curve.v2.x < 0 ? "A" : "B";
      if (target === "A") flareA = Math.max(flareA, landed);
      else if (pulse.id !== "draft") flareB = Math.max(flareB, landed);
      const label = labels.current[i];
      if (label && pulse.label) {
        const shownAt = pulse.label.at === "apex" ? pulse.launch + (pulse.land - pulse.launch) * 0.5 : pulse.land - 0.1;
        const shown = span(t, shownAt, shownAt + 0.7, pulse.fade - 0.7, pulse.fade);
        label.style.opacity = String(shown);
        label.style.filter = "blur(" + ((1 - easeOut(ramp(t, shownAt, shownAt + 0.7))) * 10).toFixed(2) + "px)";
        label.style.visibility = shown > 0.001 ? "visible" : "hidden";
      }
    });

    const draft = pulses.find(pulse => pulse.id === "draft")!;
    if (hold.current) {
      const waiting = span(t, draft.land, draft.land + 0.5, draft.fade - 0.5, draft.fade - 0.1);
      hold.current.visible = waiting > 0.01;
      hold.current.rotation.z = t * 0.9;
      hold.current.scale.setScalar(1 + Math.sin(t * 3.2) * 0.04);
      (hold.current.material as MeshBasicMaterial).opacity = waiting * 0.9;
    }

    TAPS.forEach((tap, i) => {
      const ring = rings.current[i];
      if (!ring) return;
      const life = ramp(t, tap.t, tap.t + 1.1);
      ring.visible = life > 0 && life < 1;
      ring.scale.setScalar(0.3 + easeOut(life) * 2.4);
      (ring.material as MeshBasicMaterial).opacity = (1 - life) * 0.9;
      ring.quaternion.copy(camera.quaternion);
    });

    const nudge = (seat: "A" | "B") => TAPS.reduce((sum, tap) => {
      const since = t - tap.t;
      return tap.seat === seat && since >= 0 ? sum + Math.exp(-since * 5) * Math.sin(since * 22) * 0.07 : sum;
    }, 0);
    const lift = easeInOut(ramp(t, REVEAL_START, REVEAL_START + 3)) * 0.0;
    if (budA.current) {
      budA.current.position.set(A_POS.x, A_POS.y + Math.sin(t * 0.52) * 0.06 + lift, A_POS.z);
      budA.current.rotation.set(0.05 + nudge("A"), 0.55 + Math.sin(t * 0.31) * 0.22, 0.16 + nudge("A"));
    }
    if (budB.current) {
      budB.current.position.set(B_POS.x, B_POS.y + Math.sin(t * 0.52 + 1.7) * 0.06 + lift, B_POS.z);
      budB.current.rotation.set(0.05 + nudge("B"), -0.55 + Math.sin(t * 0.31 + 2.1) * 0.22, -0.16 - nudge("B"));
    }
    if (lightA.current) lightA.current.intensity = 34 + flareA * 320;
    if (lightB.current) lightB.current.intensity = 34 + flareB * 320;
    if (dust.current) {
      dust.current.rotation.y = t * 0.012;
      dust.current.position.y = t * 0.01;
    }

    REVEAL_PULSES.forEach((_, i) => {
      const dot = dots.current[i];
      if (!dot) return;
      const pop = easeOut(ramp(t, REVEAL_START + 3.2 + i * 0.32, REVEAL_START + 3.9 + i * 0.32));
      dot.visible = pop > 0;
      dot.scale.setScalar(0.55 + pop * 0.45);
      (dot.material as MeshBasicMaterial).opacity = pop;
    });

    onTime(t);
  });

  return (
    <>
      <color attach="background" args={["#000"]} />
      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={4.2} position={[0, 6, 2]} rotation={[Math.PI / 2, 0, 0]} scale={[14, 4, 1]} />
        <Lightformer form="rect" intensity={1.1} position={[-9, 1, 3]} rotation={[0, Math.PI / 2, 0]} scale={[8, 2.5, 1]} />
        <Lightformer form="rect" intensity={1.1} position={[9, 1, 3]} rotation={[0, -Math.PI / 2, 0]} scale={[8, 2.5, 1]} />
        <Lightformer form="rect" intensity={0.12} position={[0, 0, 12]} scale={[12, 6, 1]} />
      </Environment>
      <pointLight ref={lightA} color={SEAT_A} position={[-4.6, 1.4, -1.6]} intensity={5} distance={9} />
      <pointLight ref={lightB} color={SEAT_B} position={[4.6, 1.4, -1.6]} intensity={5} distance={9} />

      <AirPod ref={budA} side={1} />
      <AirPod ref={budB} side={-1} />

      <points ref={dust} geometry={dustGeometry}>
        <pointsMaterial color="#8d9099" size={0.018} sizeAttenuation transparent opacity={0.5} depthWrite={false} />
      </points>

      {pulses.map((pulse, i) => (
        <group key={pulse.id}>
          <mesh ref={node => { tubes.current[i] = node; }} geometry={pulse.geometry} material={pulse.material} frustumCulled={false} />
          <mesh ref={node => { heads.current[i] = node; }} material={pulse.headMaterial}>
            <sphereGeometry args={[0.05, 24, 24]} />
          </mesh>
          {pulse.label && (
            <Html position={pulse.anchor} zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
              <div ref={node => { labels.current[i] = node; }} className="film-label" data-at={pulse.label.at} data-seat={pulse.color === SEAT_B ? "B" : "N"}>
                {pulse.label.taps && <span className="film-label-taps">{pulse.label.taps}</span>}
                <span className="film-label-text">{pulse.label.text}</span>
                {pulse.label.caption && <span className="film-label-caption">{pulse.label.caption}</span>}
              </div>
            </Html>
          )}
        </group>
      ))}

      {TAPS.map((tap, i) => (
        <mesh
          key={i}
          ref={node => { rings.current[i] = node; }}
          position={tap.seat === "B" ? [B_POS.x + 0.2, B_POS.y - 1.0, 0.45] : [A_POS.x - 0.2, A_POS.y - 1.0, 0.45]}
        >
          <ringGeometry args={[0.2, 0.215, 64]} />
          <meshBasicMaterial color={new Color(tap.seat === "B" ? SEAT_B : SEAT_A).multiplyScalar(HDR)} toneMapped={false} transparent depthWrite={false} depthTest={false} />
        </mesh>
      ))}

      <mesh ref={hold} position={[B_POS.x + 0.2, B_POS.y - 1.0, 0.45]} rotation={[0, -0.35, 0]}>
        <ringGeometry args={[0.42, 0.432, 96, 1, 0, Math.PI * 1.5]} />
        <meshBasicMaterial color={new Color("#ffffff").multiplyScalar(HDR * 0.7)} toneMapped={false} transparent depthWrite={false} depthTest={false} />
      </mesh>

      {REVEAL_PULSES.map((pulse, i) => (
        <mesh key={pulse.id} ref={node => { dots.current[i] = node; }} position={[-1.7 + (3.4 * i) / (REVEAL_PULSES.length - 1), REVEAL_Y, 0.3]}>
          <sphereGeometry args={[0.075, 32, 32]} />
          <meshBasicMaterial color={new Color(pulse.color).multiplyScalar(HDR)} toneMapped={false} transparent />
        </mesh>
      ))}

      <EffectComposer multisampling={4}>
        <Bloom mipmapBlur intensity={0.9} luminanceThreshold={1} luminanceSmoothing={0.2} radius={0.72} />
        <Vignette eskil={false} offset={0.22} darkness={0.72} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>
    </>
  );
}
