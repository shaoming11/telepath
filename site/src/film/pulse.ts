import { AdditiveBlending, Color, ShaderMaterial } from "three";

export function pulseMaterial(color: string) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    toneMapped: false,
    uniforms: {
      uColor: { value: new Color(color) },
      uHead: { value: -1 },
      uTail: { value: 0.34 },
      uGain: { value: 0 },
      uTrace: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vFacing;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFacing = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uHead;
      uniform float uTail;
      uniform float uGain;
      uniform float uTrace;
      varying vec2 vUv;
      varying float vFacing;
      void main() {
        float behind = uHead - vUv.x;
        float comet = behind >= 0.0 ? exp(-behind * 5.0 / uTail) : exp(behind * 90.0);
        float passed = smoothstep(0.0, 0.02, behind);
        float core = pow(vFacing, 1.6);
        vec3 hot = mix(uColor, vec3(1.0), comet * comet * 0.55);
        float energy = comet * uGain + passed * uTrace;
        gl_FragColor = vec4(hot * energy * core, 1.0);
      }
    `,
  });
}
