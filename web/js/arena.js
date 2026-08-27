/* Shared scene furniture: renderer setup, lighting, and a Mii-ish athlete rig. */

import * as THREE from "../lib/three.module.js";

export const SKIN = 0xf6c9a5;
export const HAIR = 0x3a2a22;

export function makeRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas: canvas, antialias: true, powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

export function skyDome(top, bottom) {
  const geo = new THREE.SphereGeometry(400, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(top) },
      bottom: { value: new THREE.Color(bottom) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 top; uniform vec3 bottom; varying vec3 vPos;
      void main() {
        float h = clamp(vPos.y / 400.0 * 0.5 + 0.5, 0.0, 1.0);
        gl_FragColor = vec4(mix(bottom, top, pow(h, 0.8)), 1.0);
      }`,
  });
  return new THREE.Mesh(geo, mat);
}

export function addLights(scene, opts) {
  opts = opts || {};
  const ambient = new THREE.HemisphereLight(
    opts.sky || 0xbfd8ff, opts.ground || 0x4a4438, opts.ambient || 0.85);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff2dd, opts.sun || 1.5);
  sun.position.set(-14, 26, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const d = opts.shadowRange || 26;
  sun.shadow.camera.left = -d;
  sun.shadow.camera.right = d;
  sun.shadow.camera.top = d;
  sun.shadow.camera.bottom = -d;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 90;
  sun.shadow.bias = -0.0012;
  scene.add(sun);
  scene.add(sun.target);
  return { ambient, sun };
}

function mat(color, rough) {
  return new THREE.MeshStandardMaterial({
    color: color,
    roughness: rough === undefined ? 0.72 : rough,
    metalness: 0.02,
  });
}

/**
 * A stylised athlete. Returns a group plus the joints worth animating.
 * Roughly 1.75 units tall, feet at y = 0, facing +Z.
 */
export function makeAthlete(shirtColor, opts) {
  opts = opts || {};
  const group = new THREE.Group();
  const skinMat = mat(opts.skin || SKIN, 0.85);
  const shirtMat = mat(shirtColor, 0.78);
  const pantsMat = mat(opts.pants || 0x2f3a5e, 0.8);
  const shoeMat = mat(opts.shoes || 0xf2f2f2, 0.6);
  const hairMat = mat(opts.hair || HAIR, 0.9);

  // legs -----------------------------------------------------------------
  const legs = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.16, 0.86, 0);
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.115, 0.5, 6, 12), pantsMat);
    leg.position.y = -0.36;
    leg.castShadow = true;
    hip.add(leg);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.13, 0.36), shoeMat);
    shoe.position.set(0, -0.79, 0.06);
    shoe.castShadow = true;
    hip.add(shoe);
    group.add(hip);
    legs.push(hip);
  }

  // torso ----------------------------------------------------------------
  const torso = new THREE.Group();
  torso.position.y = 0.86;
  group.add(torso);

  const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.29, 0.34, 6, 16), shirtMat);
  chest.position.y = 0.26;
  chest.scale.set(1.05, 1, 0.82);
  chest.castShadow = true;
  torso.add(chest);

  // arms -----------------------------------------------------------------
  const arms = {};
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.33, 0.44, 0);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.26, 5, 10), shirtMat);
    upper.position.y = -0.18;
    upper.castShadow = true;
    shoulder.add(upper);

    const elbow = new THREE.Group();
    elbow.position.y = -0.34;
    shoulder.add(elbow);

    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.24, 5, 10), skinMat);
    fore.position.y = -0.16;
    fore.castShadow = true;
    elbow.add(fore);

    const hand = new THREE.Group();
    hand.position.y = -0.32;
    const fist = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), skinMat);
    fist.castShadow = true;
    hand.add(fist);
    elbow.add(hand);

    torso.add(shoulder);
    const key = side < 0 ? "right" : "left";   // as seen from behind the athlete
    arms[key] = { shoulder, elbow, hand };
  }

  // head -----------------------------------------------------------------
  const neck = new THREE.Group();
  neck.position.y = 0.62;
  torso.add(neck);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.245, 24, 20), skinMat);
  head.position.y = 0.2;
  head.scale.set(1, 1.08, 0.96);
  head.castShadow = true;
  neck.add(head);

  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.258, 24, 20, 0, Math.PI * 2, 0, Math.PI * 0.58), hairMat);
  hair.position.y = 0.21;
  hair.scale.set(1, 1.12, 1);
  neck.add(hair);

  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x22242e, roughness: 0.35 });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), eyeMat);
    eye.position.set(side * 0.085, 0.225, 0.215);
    eye.scale.set(1, 1.25, 0.6);
    neck.add(eye);
  }

  group.userData = { torso, neck, head, arms, legs, shirtMat };
  return group;
}

/** Neutral idle sway so nobody looks frozen. */
export function idlePose(athlete, t) {
  const d = athlete.userData;
  d.torso.rotation.z = Math.sin(t * 1.6) * 0.02;
  d.torso.position.y = 0.86 + Math.sin(t * 2.4) * 0.012;
  d.arms.left.shoulder.rotation.x = -0.15 + Math.sin(t * 1.6) * 0.06;
  d.arms.right.shoulder.rotation.x = -0.15 + Math.sin(t * 1.6 + 0.6) * 0.06;
  d.arms.left.shoulder.rotation.z = 0.22;
  d.arms.right.shoulder.rotation.z = -0.22;
  d.arms.left.elbow.rotation.x = -0.35;
  d.arms.right.elbow.rotation.x = -0.35;
}

/** A soft round shadow blob, cheaper and tidier than a real shadow for balls. */
export function blobShadow(radius) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(0,0,0,0.55)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/**
 * Draw the same scene once per camera, side by side.
 *
 * The scissor test is what makes this work: with it enabled each pass clears
 * and draws only inside its own strip, so the two views do not wipe each
 * other out. Vertical strips suit both sports here - a tennis court is long
 * and thin, and a boxing view is mostly head-height.
 */
export function renderSplit(renderer, scene, cameras) {
  const size = new THREE.Vector2();
  renderer.getSize(size);
  const n = cameras.length;
  if (n === 1) {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, size.x, size.y);
    renderer.render(scene, cameras[0]);
    return;
  }

  const w = Math.floor(size.x / n);
  renderer.setScissorTest(true);
  for (let i = 0; i < n; i++) {
    const x = i * w;
    const width = (i === n - 1) ? size.x - x : w;   // avoid a rounding seam
    renderer.setViewport(x, 0, width, size.y);
    renderer.setScissor(x, 0, width, size.y);
    const cam = cameras[i];
    const aspect = width / size.y;
    if (cam.aspect !== aspect) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
    renderer.render(scene, cam);
  }
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, size.x, size.y);
}

export function lerp(a, b, t) { return a + (b - a) * t; }
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}
