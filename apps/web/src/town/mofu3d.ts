/**
 * Mofu in 3D: a round, furry body (shell-textured fur), glossy eyes, pink ears and cheeks, feet
 * with toe beans and little arms. update() breathes, blinks, twitches ears and walks.
 */
import * as THREE from "three";

export interface MofuState {
  moving: boolean;
  /** 0–1, how fast it walks (1 = running). */
  speed: number;
  /** True while standing at a door: Mofu hops happily. */
  happy: boolean;
}

function noiseTexture(size: number, seed: number): THREE.DataTexture {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = Math.floor(rnd() * 255);
    data.set([v, v, v, 255], i * 4);
  }
  const t = new THREE.DataTexture(data, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

const FUR_VERTEX = /* glsl */ `
  uniform float uLayer;
  uniform float uFurLength;
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vObjNormal;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vUv = uv;
    vObjNormal = normalize(normal);
    vec3 p = position + normal * uFurLength * uLayer;
    // fur droops a little and sways in the night breeze
    p.y -= uFurLength * uLayer * uLayer * 0.6;
    p.x += sin(uTime * 1.7 + position.y * 4.0) * 0.012 * uLayer * uLayer;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vView = -mv.xyz;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mv;
  }
`;

const FUR_FRAGMENT = /* glsl */ `
  uniform float uLayer;
  uniform sampler2D uNoise;
  uniform vec3 uSky;
  uniform vec3 uGround;
  uniform vec3 uKeyDir;
  uniform vec3 uRim;
  uniform vec3 uFur;
  uniform vec3 uBlush;
  varying vec2 vUv;
  varying vec3 vObjNormal;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec3 n = normalize(vObjNormal);
    // short fur around the eyes and mouth so the face stays clean
    float face = max(
      max(smoothstep(0.955, 0.985, dot(n, normalize(vec3(-0.36, 0.2, 0.91)))),
          smoothstep(0.955, 0.985, dot(n, normalize(vec3(0.36, 0.2, 0.91))))),
      smoothstep(0.975, 0.995, dot(n, normalize(vec3(0.0, -0.04, 1.0))))
    );
    float strand = texture2D(uNoise, vUv * vec2(70.0, 38.0)).r;
    float threshold = mix(0.0, 0.92, uLayer) + face * uLayer * 2.0;
    if (uLayer > 0.0 && strand < threshold) discard;
    float blush = max(
      smoothstep(0.90, 0.975, dot(n, normalize(vec3(-0.6, -0.02, 0.8)))),
      smoothstep(0.90, 0.975, dot(n, normalize(vec3(0.6, -0.02, 0.8))))
    );
    vec3 base = mix(uFur, uBlush, blush * 0.85);
    // roots are darker (self-shadow), tips catch the light
    float ao = mix(0.62, 1.0, uLayer);
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vView);
    vec3 hemi = mix(uGround, uSky, N.y * 0.5 + 0.5);
    float key = max(dot(N, normalize(uKeyDir)), 0.0);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 2.4);
    vec3 col = base * (hemi * 0.85 + key * 0.55) * ao + uRim * rim * 0.45 * (0.4 + uLayer);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createMofu(opts: { furLayers: number }) {
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  const FEET = 0.22;
  const R = 0.95;
  const bodyGeo = new THREE.SphereGeometry(R, 56, 40);
  const noise = noiseTexture(256, 4242);
  const uniforms = {
    uNoise: { value: noise },
    uFurLength: { value: 0.085 },
    uTime: { value: 0 },
    uSky: { value: new THREE.Color("#d9cfff") },
    uGround: { value: new THREE.Color("#5a3a58") },
    uKeyDir: { value: new THREE.Vector3(-0.4, 0.8, 0.6) },
    uRim: { value: new THREE.Color("#ff9cc8") },
    uFur: { value: new THREE.Color("#fbf5f8") },
    uBlush: { value: new THREE.Color("#ff9ccb") },
  };
  const body = new THREE.Group();
  body.scale.set(1.18, 0.98, 1);
  body.position.y = FEET + R * 0.98;
  bodyGroup.add(body);
  for (let i = 0; i <= opts.furLayers; i++) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uLayer: { value: i / opts.furLayers } },
      vertexShader: FUR_VERTEX,
      fragmentShader: FUR_FRAGMENT,
    });
    const shell = new THREE.Mesh(bodyGeo, mat);
    shell.renderOrder = i;
    shell.castShadow = i === 0;
    body.add(shell);
  }
  const shared = () => uniforms.uTime;

  // ears: white outside, pink inside
  // Limbs and ears: soft white that stays bright at night (a touch of emissive).
  const furMat = new THREE.MeshStandardMaterial({
    color: "#fbf5f8",
    emissive: "#8a7a86",
    roughness: 0.95,
    bumpMap: noise,
    bumpScale: 0.6,
  });
  const pinkMat = new THREE.MeshStandardMaterial({
    color: "#ff8fc0",
    emissive: "#a03a68",
    roughness: 0.7,
  });
  const ears = [-1, 1].map((side) => {
    const ear = new THREE.Group();
    // rounded cat ears: a squashed sphere, pink inside
    const outer = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 18), furMat);
    outer.scale.set(0.3, 0.38, 0.17);
    const inner = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), pinkMat);
    inner.scale.set(0.19, 0.26, 0.08);
    inner.position.set(0, -0.02, 0.1);
    ear.add(outer, inner);
    ear.position.set(side * 0.6, 0.84, 0.12);
    ear.rotation.z = -side * 0.42;
    ear.rotation.x = -0.12;
    body.add(ear);
    return ear;
  });

  // eyes: glossy black with a sparkle
  const eyeMat = new THREE.MeshStandardMaterial({
    color: "#140c12",
    roughness: 0.12,
    metalness: 0.1,
  });
  const sparkleMat = new THREE.MeshBasicMaterial({ color: "#ffffff" });
  const eyes = [-1, 1].map((side) => {
    const eye = new THREE.Group();
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 18), eyeMat);
    ball.scale.set(1, 1.18, 0.7);
    const sparkle = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), sparkleMat);
    sparkle.position.set(-0.045, 0.06, 0.1);
    const sparkle2 = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), sparkleMat);
    sparkle2.position.set(0.05, -0.05, 0.1);
    eye.add(ball, sparkle, sparkle2);
    const dir = new THREE.Vector3(side * 0.36, 0.2, 0.91).normalize();
    eye.position.copy(dir).multiplyScalar(R * 1.02);
    body.add(eye);
    return eye;
  });

  // mouth: a tiny smile
  const mouth = new THREE.Mesh(
    new THREE.TorusGeometry(0.075, 0.018, 8, 20, Math.PI),
    new THREE.MeshBasicMaterial({ color: "#2a1620" }),
  );
  mouth.rotation.z = Math.PI;
  mouth.position.copy(new THREE.Vector3(0, -0.04, 1).normalize().multiplyScalar(R * 1.03));
  body.add(mouth);

  // arms and feet
  const arms = [-1, 1].map((side) => {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.16, 6, 12), furMat);
    arm.position.set(side * 1.08, FEET + 0.72, 0.18);
    arm.rotation.z = side * 0.5;
    bodyGroup.add(arm);
    return arm;
  });
  const beanMat = new THREE.MeshStandardMaterial({ color: "#ff9ccb", roughness: 0.6 });
  const feet = [-1, 1].map((side) => {
    const foot = new THREE.Group();
    const pad = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), furMat);
    pad.scale.set(0.27, 0.17, 0.34);
    pad.position.y = 0.17;
    foot.add(pad);
    for (const [bx, bz, r] of [
      [0, 0.2, 0.07],
      [-0.12, 0.13, 0.045],
      [0.12, 0.13, 0.045],
    ] as const) {
      const bean = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), beanMat);
      bean.position.set(bx, 0.09, bz + 0.08);
      bean.scale.y = 0.6;
      foot.add(bean);
    }
    foot.position.set(side * 0.46, 0, 0.12);
    root.add(foot);
    return foot;
  });

  // ---------------------------------------------------------------- animation
  let t = 0;
  let phase = 0;
  let nextBlink = 1.5;
  let blink = 0;
  let nextTwitch = 2.5;
  let twitch = 0;
  let twitchSide = 0;
  let hopClock = 0;
  const rand = () => Math.random();

  function update(dt: number, s: MofuState) {
    t += dt;
    shared().value = t;
    // walking: steps, bounce, lean
    phase = s.moving ? phase + dt * (9 + s.speed * 5) : phase * 0.9;
    const bounce = s.moving ? Math.abs(Math.sin(phase)) * (0.1 + s.speed * 0.06) : 0;
    // happy hops at a door
    hopClock = s.happy && !s.moving ? hopClock + dt : 0;
    const hop = s.happy && !s.moving ? Math.max(0, Math.sin(hopClock * 5)) * 0.22 : 0;
    const breathe = Math.sin(t * 2.3) * 0.022;
    bodyGroup.position.y = bounce + hop;
    const squash = s.moving ? Math.abs(Math.cos(phase)) * 0.05 : hop > 0 ? -0.04 : 0;
    body.scale.set(
      1.18 * (1 + squash * 0.6 - breathe * 0.3),
      0.98 * (1 - squash + breathe),
      1 * (1 + squash * 0.4),
    );
    bodyGroup.rotation.x = THREE.MathUtils.lerp(
      bodyGroup.rotation.x,
      s.moving ? 0.1 + s.speed * 0.08 : 0,
      Math.min(1, dt * 8),
    );
    bodyGroup.rotation.z = s.moving ? Math.sin(phase) * 0.04 : Math.sin(t * 0.9) * 0.015;
    feet.forEach((f, k) => {
      const st = s.moving ? Math.sin(phase + k * Math.PI) : 0;
      f.position.z = 0.12 + st * 0.26;
      f.position.y = Math.max(0, st) * 0.14 + hop * 0.6;
      f.rotation.x = -st * 0.3;
    });
    arms.forEach((a, k) => {
      const side = k === 0 ? -1 : 1;
      const swing = s.moving ? Math.sin(phase + k * Math.PI) * 0.6 : Math.sin(t * 2.3 + k) * 0.05;
      a.rotation.x = swing;
      a.rotation.z = side * (0.5 + (hop > 0.05 ? 0.7 : 0));
    });
    // blink every few seconds
    nextBlink -= dt;
    if (nextBlink <= 0) {
      blink = 0.16;
      nextBlink = 2 + rand() * 3.5;
    }
    blink = Math.max(0, blink - dt);
    const lid = blink > 0 ? Math.abs(Math.sin((blink / 0.16) * Math.PI)) : 0;
    const smile = s.happy ? 0.35 : 0;
    for (const e of eyes) e.scale.y = Math.max(0.08, 1 - lid * 0.95 - smile * 0.5);
    // an ear twitches now and then
    nextTwitch -= dt;
    if (nextTwitch <= 0) {
      twitch = 0.35;
      twitchSide = rand() < 0.5 ? 0 : 1;
      nextTwitch = 3 + rand() * 4;
    }
    twitch = Math.max(0, twitch - dt);
    ears.forEach((ear, k) => {
      const side = k === 0 ? -1 : 1;
      const tw =
        k === twitchSide && twitch > 0 ? Math.sin((twitch / 0.35) * Math.PI * 3) * 0.25 : 0;
      ear.rotation.z = -side * (0.42 + tw) + (s.moving ? side * Math.sin(phase * 2) * 0.05 : 0);
    });
  }

  return { group: root, update };
}
