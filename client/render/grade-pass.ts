// Cheap full-screen "camera grade" post pass: vignette, chromatic aberration,
// film grain, a red damage vignette, a white flash overlay, and a small
// contrast/saturation lift. Renderer feeds it fresh uniforms every frame via
// setUniforms(); everything else about it is a static ShaderPass.
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const VERTEX_SHADER = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
uniform sampler2D tDiffuse;
uniform float time;
uniform float damage;
uniform float flash;
varying vec2 vUv;

float grainNoise(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453123);
}

void main() {
  vec2 centered = vUv - 0.5;
  float dist = length(centered);

  // Chromatic aberration: sample red/blue slightly offset outward from centre.
  vec2 caOffset = centered * 0.002;
  float r = texture2D(tDiffuse, vUv + caOffset).r;
  float g = texture2D(tDiffuse, vUv).g;
  float b = texture2D(tDiffuse, vUv - caOffset).b;
  vec3 color = vec3(r, g, b);

  // Vignette.
  float vig = smoothstep(0.85, 0.35, dist);
  color *= mix(0.55, 1.0, vig);

  // Film grain.
  float grain = (grainNoise(vUv * (time * 60.0 + 1.0)) - 0.5) * 0.03;
  color += grain;

  // Damage: a red vignette from the edges that intensifies with `damage`.
  float damageVig = smoothstep(0.15, 0.75, dist) * clamp(damage, 0.0, 1.0);
  color = mix(color, vec3(0.55, 0.0, 0.0), damageVig * 0.85);

  // Flash: additive white-out, strongest at the centre, soft falloff outward.
  float flashFalloff = 1.0 - smoothstep(0.0, 1.1, dist);
  color += vec3(clamp(flash, 0.0, 1.0)) * flashFalloff;

  // Slight contrast + saturation lift.
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luma), color, 1.06);
  color = (color - 0.5) * 1.03 + 0.5;

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

/** Post-processing pass applying screen-space camera "feel": vignette, chromatic
 * aberration, grain, and the damage/flash overlays driven by Renderer.grade. */
export class GradePass extends ShaderPass {
  constructor() {
    super(
      {
        uniforms: {
          tDiffuse: { value: null },
          time: { value: 0 },
          damage: { value: 0 },
          flash: { value: 0 },
        },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
      },
      'tDiffuse',
    );
  }

  /** Called once per frame by Renderer.render() before the composer runs. */
  setUniforms(damage: number, flash: number, timeSeconds: number): void {
    this.uniforms.damage.value = damage;
    this.uniforms.flash.value = flash;
    this.uniforms.time.value = timeSeconds;
  }
}
