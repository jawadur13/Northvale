/**
 * Rivers and roads.
 *
 * Both are ribbons, and both face the same problem: a river is 400 m wide, the
 * world is 4,096 km across, and at world zoom 400 m is a twentieth of a pixel.
 * Drawing them at true width makes them invisible; drawing them at a fixed pixel
 * width makes them absurd up close.
 *
 * The solution is the one printed atlases use. The vertex shader expands each
 * ribbon to `max(trueHalfWidth, minimumOnScreenWidth)`, where the minimum is
 * derived per frame from the camera distance so it corresponds to a roughly
 * constant number of pixels. Zoomed out, the Silverburn is a legible hairline;
 * zoomed in, it is 400 m of water in a valley it cut itself. Nothing is rebuilt
 * in between - it is one uniform.
 */

import * as THREE from 'three';
import type { WorldUniforms } from '../WorldResources';
import { NOISE_GLSL } from '../terrain/terrainShaders';

const RIBBON_VERTEX = /* glsl */ `
precision highp float;

in vec3 position;      // x, heightKm, z
in vec2 aPerp;         // unit perpendicular in the ground plane
in vec4 aParams;       // side (-1/+1), halfWidthKm, alongKm, kindFlag

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;
uniform float uExaggeration;
uniform float uMinRibbonKm;
uniform float uWidthScale;
uniform float uLift;

out float vSide;
out float vAlong;
out float vKind;
out float vWidthKm;
out float vTrueWidthKm;
out vec3 vWorld;
out float vViewDist;

void main() {
  float halfWidth = max(aParams.y * uWidthScale, uMinRibbonKm);
  vec2 xz = position.xz + aPerp * (aParams.x * halfWidth);

  // Lift scales with distance so the ribbon never sinks into the terrain's
  // high-frequency detail, and never floats visibly when the camera is close.
  float dist = length(vec3(xz.x, position.y * uExaggeration, xz.y) - cameraPosition);
  float lift = uLift * (1.0 + dist * 0.0016);

  vec3 world = vec3(xz.x, position.y * uExaggeration + lift, xz.y);
  vWorld = world;
  vSide = aParams.x;
  vAlong = aParams.z;
  vKind = aParams.w;
  vWidthKm = halfWidth;
  // The *hydrological* width, kept separate from the drawn width. Colour has to
  // come from this one, or every river turns deep-channel navy the moment the
  // camera pulls back and the minimum on-screen width takes over.
  vTrueWidthKm = aParams.y;
  vViewDist = dist;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const RIVER_FRAGMENT = /* glsl */ `
precision highp float;

in float vSide;
in float vAlong;
in float vKind;
in float vWidthKm;
in float vTrueWidthKm;
in vec3 vWorld;
in float vViewDist;

out vec4 fragColor;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogHeight;
uniform float uTime;
uniform vec3 uCamPos;
uniform float uWaterDetail;

${NOISE_GLSL}

void main() {
  float edge = abs(vSide);
  // Soft banks. Antialiasing the edge in UV rather than in screen space keeps a
  // hairline river from shimmering as the camera moves.
  float bank = 1.0 - smoothstep(0.55, 1.0, edge);

  // Flow: streaks that drift downstream, scaled so they read at any zoom.
  float detail = uWaterDetail * (1.0 - smoothstep(14.0, 120.0, vViewDist));
  float flow = 0.0;
  if (detail > 0.001) {
    flow = nvFbm(vec2(vAlong * 0.55 - uTime * 0.7, vSide * 2.4), 2) * detail;
  }

  vec3 shallow = vec3(0.34, 0.53, 0.56);
  vec3 deepCol = vec3(0.13, 0.30, 0.44);
  // Wider channels carry deeper water, judged by real discharge rather than by
  // how many pixels the ribbon happens to occupy.
  vec3 col = mix(shallow, deepCol, clamp(vTrueWidthKm / 1.4, 0.0, 1.0));
  col += vec3(0.10, 0.13, 0.14) * flow;

  // A specular sheen along the centre of the channel.
  vec3 V = normalize(uCamPos - vWorld);
  vec3 N = normalize(vec3(flow * 0.25, 1.0, flow * 0.2));
  vec3 H = normalize(uSunDir + V);
  col += uSunColor * pow(max(dot(N, H), 0.0), 40.0) * 0.35 * (1.0 - edge * 0.6) * detail;
  col += uSkyColor * 0.16;

  float heightFactor = exp(-max(vWorld.y, 0.0) / uFogHeight);
  float fogAmount = clamp(1.0 - exp(-vViewDist * uFogDensity * heightFactor), 0.0, 0.94);
  col = mix(col, uFogColor, fogAmount);

  fragColor = vec4(col, bank);
}
`;

const ROAD_FRAGMENT = /* glsl */ `
precision highp float;

in float vSide;
in float vAlong;
in float vKind;
in float vWidthKm;
in float vTrueWidthKm;
in vec3 vWorld;
in float vViewDist;

out vec4 fragColor;

uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogHeight;
uniform vec3 uSunColor;
uniform float uRoadFilter;

void main() {
  // Layer filter: the layers panel can show trunk roads only, which at world
  // zoom is the difference between a legible network and a beige smear.
  if (vKind > uRoadFilter + 0.5) discard;

  float edge = abs(vSide);
  float body = 1.0 - smoothstep(0.5, 1.0, edge);

  // Colour by class: metalled highways are pale, tracks and lanes are earthen,
  // caravan routes are the colour of the desert they cross.
  vec3 col;
  if (vKind < 1.5) col = vec3(0.80, 0.73, 0.60);        // highway
  else if (vKind < 2.5) col = vec3(0.72, 0.64, 0.50);   // road
  else if (vKind < 3.5) col = vec3(0.78, 0.68, 0.48);   // caravan
  else if (vKind < 4.5) col = vec3(0.60, 0.53, 0.42);   // track
  else col = vec3(0.54, 0.48, 0.39);                    // lane

  // Caravan routes and tracks are dashed, which is the cartographic convention
  // for an unmetalled way and also stops them competing with the rivers.
  float alpha = body;
  if (vKind > 2.5) {
    float dashScale = vKind > 4.5 ? 1.6 : 1.1;
    float dash = step(0.42, fract(vAlong / dashScale));
    alpha *= mix(0.30, 1.0, dash);
  }

  // A darker casing along the edge gives the ribbon definition against the ground.
  col = mix(col * 0.62, col, 1.0 - smoothstep(0.45, 0.95, edge));
  col *= 0.85 + 0.15 * uSunColor.r;

  float heightFactor = exp(-max(vWorld.y, 0.0) / uFogHeight);
  float fogAmount = clamp(1.0 - exp(-vViewDist * uFogDensity * heightFactor), 0.0, 0.94);
  col = mix(col, uFogColor, fogAmount);

  fragColor = vec4(col, alpha);
}
`;

export interface RibbonBuffers {
  positions: Float32Array;
  perp: Float32Array;
  params: Float32Array;
  indices: Uint32Array;
}

export class Ribbon {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.RawShaderMaterial;

  constructor(
    buffers: RibbonBuffers,
    uniforms: WorldUniforms,
    kind: 'river' | 'road',
    camPos: THREE.Vector3,
  ) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
    geo.setAttribute('aPerp', new THREE.BufferAttribute(buffers.perp, 2));
    geo.setAttribute('aParams', new THREE.BufferAttribute(buffers.params, 4));
    geo.setIndex(new THREE.BufferAttribute(buffers.indices, 1));
    // The vertex shader moves everything, so a conservative sphere is correct.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 6000);

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...(uniforms as unknown as Record<string, THREE.IUniform>),
        uWidthScale: { value: 1 },
        uLift: { value: kind === 'river' ? 0.004 : 0.006 },
        uCamPos: { value: camPos },
        uWaterDetail: { value: 1 },
        uRoadFilter: { value: 5 },
      },
      vertexShader: RIBBON_VERTEX,
      fragmentShader: kind === 'river' ? RIVER_FRAGMENT : ROAD_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = kind === 'river' ? 4 : 5;
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Coastline and political borders, drawn as line segments draped over the
 * terrain. Kept as a separate material because lines need a constant screen
 * width, which a ribbon cannot give without becoming a ribbon.
 */
const LINE_VERTEX = /* glsl */ `
precision highp float;

in vec3 position;   // x, heightKm, z

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;
uniform float uExaggeration;
uniform float uLift;

out float vViewDist;
out vec3 vWorld;

void main() {
  vec3 world = vec3(position.x, position.y * uExaggeration + uLift, position.z);
  vWorld = world;
  vViewDist = length(world - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const LINE_FRAGMENT = /* glsl */ `
precision highp float;

in float vViewDist;
in vec3 vWorld;

out vec4 fragColor;

uniform vec3 uLineColor;
uniform float uLineOpacity;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogHeight;

void main() {
  float heightFactor = exp(-max(vWorld.y, 0.0) / uFogHeight);
  float fogAmount = clamp(1.0 - exp(-vViewDist * uFogDensity * heightFactor), 0.0, 0.9);
  vec3 col = mix(uLineColor, uFogColor, fogAmount * 0.8);
  fragColor = vec4(col, uLineOpacity);
}
`;

export class WorldLines {
  readonly object: THREE.LineSegments;
  readonly material: THREE.RawShaderMaterial;

  constructor(
    vertices: Float32Array,
    uniforms: WorldUniforms,
    color: THREE.Color,
    opacity: number,
    lift: number,
  ) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 6000);

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...(uniforms as unknown as Record<string, THREE.IUniform>),
        uLineColor: { value: color },
        uLineOpacity: { value: opacity },
        uLift: { value: lift },
      },
      vertexShader: LINE_VERTEX,
      fragmentShader: LINE_FRAGMENT,
      transparent: true,
      depthWrite: false,
    });

    this.object = new THREE.LineSegments(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 6;
    this.object.visible = false;
  }

  setVisible(v: boolean): void {
    this.object.visible = v;
  }

  setOpacity(v: number): void {
    this.material.uniforms.uLineOpacity.value = v;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
