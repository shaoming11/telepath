import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";
import { Bloom, EffectComposer, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshBasicMaterial, PerspectiveCamera,
  PointLight, Points, ShaderMaterial, TubeGeometry, Vector3,
} from "three";
import { AirPod } from "./AirPod";
import {
  A_POS, B_POS, PULSES, REVEAL_PULSES, REVEAL_SPREAD, REVEAL_START, REVEAL_Y, SEAT_A, SEAT_B, TAPS, cameraAt, clamp01, easeInOut, easeOut, ramp,
  revealDot, span,
} from "./choreo";
import { pulseMaterial } from "./pulse";

const HDR = 3.2;

const WHISPERS = PULSES.filter(pulse => pulse.id === "first" || pulse.id === "approved")
  .flatMap(pulse => [0, 1, 2].map(ring => ({ at: pulse.land, ring })));

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}


type Props = {
  clock: { current: number };
  labels: { current: (HTMLDivElement | null)[] };
  revealLabels: { current: (HTMLDivElement | null)[] };
  onTime: (t: number) => void;
  onFrame?: (delta: number) => void;
  onReady?: () => void;
};

export function Scene({ clock, labels, revealLabels, onTime, onFrame, onReady }: Props) {
  const camera = useThree(state => state.camera) as PerspectiveCamera;
  const size = useThree(state => state.size);
  const scene = useThree(state => state.scene);
  const budA = useRef<Group>(null);
  const budB = useRef<Group>(null);
  const lightA = useRef<PointLight>(null);
  const lightB = useRef<PointLight>(null);
  const dust = useRef<Points>(null);
  const tubes = useRef<(Mesh | null)[]>([]);
  const heads = useRef<(Mesh | null)[]>([]);
  const rings = useRef<(Mesh | null)[]>([]);
  const dots = useRef<(Mesh | null)[]>([]);
  const hold = useRef<Mesh>(null);
  const whispers = useRef<(Mesh | null)[]>([]);
  const thread = useRef<Mesh>(null);
  const look = useMemo(() => new Vector3(), []);
  const point = useMemo(() => new Vector3(), []);

  const pulses = useMemo(() => PULSES.map(pulse => ({
    ...pulse,
    geometry: new TubeGeometry(pulse.curve, 180, 0.02, 10, false),
    material: pulseMaterial(pulse.color),
    headMaterial: new MeshBasicMaterial({ color: new Color(pulse.color).multiplyScalar(HDR * 1.6), toneMapped: false, transparent: true, blending: AdditiveBlending, depthWrite: false }),
    anchor: pulse.label?.at === "apex" ? pulse.curve.getPoint(0.5).add(new Vector3(0, 0.26, 0))
      : pulse.label?.at === "A" ? new Vector3(-1.75, 0.75, 0.4)
      : new Vector3(2.05, 0.35, 0.6),
  })), []);

  useEffect(() => { onReady?.(); }, [onReady]);

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

  useFrame((_, delta) => {
    onFrame?.(delta);
    const t = clock.current;
    cameraAt(t, size.width / size.height, camera.position, look);
    camera.lookAt(look);
    scene.environmentIntensity = 0.04 + 1.66 * easeInOut(ramp(t, 1.6, 4.4));

    const reveal = easeInOut(ramp(t, REVEAL_START + 1.8, REVEAL_START + 3.8));
    const spread = easeInOut(ramp(t, REVEAL_START + 0.6, REVEAL_START + 3.4));
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
      uniforms.uTrace.value = back > 0 ? back * 0.55 * (1 - ramp(reveal, 0.85, 1)) : 0.2 * alive * ramp(t, pulse.launch, pulse.launch + 0.2);
      const tube = tubes.current[i];
      if (tube) {
        const flat = pulse.inReveal ? 1 - reveal * 0.985 : 1;
        tube.scale.x = pulse.inReveal ? 1 + (spread * REVEAL_SPREAD) / Math.abs(pulse.curve.v0.x) : 1;
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
        label.style.visibility = shown > 0.001 ? "visible" : "hidden";
        if (shown > 0.001) {
          point.copy(pulse.anchor).project(camera);
          label.style.transform = "translate3d(" + ((point.x * 0.5 + 0.5) * size.width).toFixed(1) + "px," + ((0.5 - point.y * 0.5) * size.height).toFixed(1) + "px,0)";
          label.style.opacity = String(shown);
          label.style.filter = "blur(" + ((1 - easeOut(ramp(t, shownAt, shownAt + 0.7))) * 10).toFixed(2) + "px)";
        }
      }
    });

    WHISPERS.forEach((whisper, i) => {
      const ring = whispers.current[i];
      if (!ring) return;
      const life = ramp(t, whisper.at + whisper.ring * 0.28, whisper.at + whisper.ring * 0.28 + 1.5);
      ring.visible = life > 0 && life < 1;
      ring.scale.setScalar(0.5 + easeOut(life) * (0.9 + whisper.ring * 0.5));
      (ring.material as MeshBasicMaterial).opacity = Math.sin(life * Math.PI) * 0.8;
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
      ring.scale.setScalar(0.3 + easeOut(life) * 1.3);
      (ring.material as MeshBasicMaterial).opacity = (1 - life) * 0.9;
      ring.quaternion.copy(camera.quaternion);
    });

    const nudge = (seat: "A" | "B") => TAPS.reduce((sum, tap) => {
      const since = t - tap.t;
      return tap.seat === seat && since >= 0 ? sum + Math.exp(-since * 5) * Math.sin(since * 22) * 0.07 : sum;
    }, 0);
    const apart = spread * REVEAL_SPREAD;
    if (thread.current) {
      const drawn = ramp(reveal, 0.7, 1);
      thread.current.visible = drawn > 0;
      thread.current.scale.x = 2 * (Math.abs(A_POS.x) + apart) - 1.1;
      (thread.current.material as MeshBasicMaterial).opacity = drawn * 0.5;
    }
    if (budA.current) {
      budA.current.position.set(A_POS.x - apart, A_POS.y + Math.sin(t * 0.52) * 0.06, A_POS.z);
      budA.current.rotation.set(0.05 + nudge("A"), 0.55 + Math.sin(t * 0.31) * 0.22, 0.16 + nudge("A"));
    }
    if (budB.current) {
      budB.current.position.set(B_POS.x + apart, B_POS.y + Math.sin(t * 0.52 + 1.7) * 0.06, B_POS.z);
      budB.current.rotation.set(0.05 + nudge("B"), -0.55 + Math.sin(t * 0.31 + 2.1) * 0.22, -0.16 - nudge("B"));
    }
    if (lightA.current) {
      lightA.current.position.x = -4.6 - apart;
      lightA.current.intensity = 34 + flareA * 320;
    }
    if (lightB.current) {
      lightB.current.position.x = 4.6 + apart;
      lightB.current.intensity = 34 + flareB * 320;
    }
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
      const label = revealLabels.current[i];
      if (!label) return;
      label.style.visibility = pop > 0.001 ? "visible" : "hidden";
      if (pop > 0.001) {
        revealDot(i, point).project(camera);
        label.style.transform = "translate3d(" + ((point.x * 0.5 + 0.5) * size.width).toFixed(1) + "px," + ((0.5 - point.y * 0.5) * size.height).toFixed(1) + "px,0)";
        label.style.opacity = String(pop);
      }
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
        <Lightformer form="rect" intensity={0.5} position={[0, 2, 12]} scale={[14, 5, 1]} />
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
        </group>
      ))}

      {TAPS.map((tap, i) => (
        <mesh
          key={i}
          ref={node => { rings.current[i] = node; }}
          position={tap.seat === "B" ? [B_POS.x, B_POS.y, 0.6] : [A_POS.x, A_POS.y, 0.6]}
        >
          <ringGeometry args={[0.2, 0.226, 64]} />
          <meshBasicMaterial color={new Color(tap.seat === "B" ? SEAT_B : SEAT_A).multiplyScalar(HDR)} toneMapped={false} transparent depthWrite={false} depthTest={false} />
        </mesh>
      ))}

      {WHISPERS.map((whisper, i) => (
        <mesh key={i} ref={node => { whispers.current[i] = node; }} position={[A_POS.x + 0.62, A_POS.y, 0.5]} rotation={[0, 0.2, 0]}>
          <ringGeometry args={[0.3, 0.312, 48, 1, -0.6, 1.2]} />
          <meshBasicMaterial color={new Color(SEAT_B).multiplyScalar(HDR)} toneMapped={false} transparent depthWrite={false} depthTest={false} />
        </mesh>
      ))}

      <mesh ref={hold} position={[B_POS.x, B_POS.y, 0.6]} rotation={[0, -0.35, 0]}>
        <ringGeometry args={[0.66, 0.674, 96, 1, 0, Math.PI * 1.5]} />
        <meshBasicMaterial color={new Color("#ffffff").multiplyScalar(HDR * 0.7)} toneMapped={false} transparent depthWrite={false} depthTest={false} />
      </mesh>

      <mesh ref={thread} position={[0, REVEAL_Y, 0.2]}>
        <boxGeometry args={[1, 0.014, 0.014]} />
        <meshBasicMaterial color="#8e8e93" transparent depthWrite={false} />
      </mesh>

      {REVEAL_PULSES.map((pulse, i) => (
        <mesh key={pulse.id} ref={node => { dots.current[i] = node; }} position={revealDot(i, new Vector3())}>
          <sphereGeometry args={[0.095, 32, 32]} />
          <meshBasicMaterial color={new Color(pulse.color).multiplyScalar(HDR)} toneMapped={false} transparent />
        </mesh>
      ))}

      <EffectComposer multisampling={4}>
        <Bloom mipmapBlur intensity={0.9} luminanceThreshold={1} luminanceSmoothing={0.2} radius={0.72} />
        <Vignette eskil={false} offset={0.22} darkness={0.72} />
        <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      </EffectComposer>
    </>
  );
}
