/*
 * Racing.
 *
 * Hold the phone sideways, like a steering wheel. Rotating it swings gravity
 * around inside the phone's own screen plane, and the angle of that is the
 * steering input (see Controller._rawWheel) - so it works whichever way up the
 * handset was picked up. The right half of the touchscreen is the throttle,
 * the left half the brake.
 *
 * The circuit is one closed Catmull-Rom spline. Everything else is derived
 * from it: the road mesh, the kerbs, the walls, where the car is on the lap,
 * whether it is on the tarmac, and the line the computer drivers follow.
 */

import * as THREE from "../../lib/three.module.js";
import { addLights, skyDome, renderSplit, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";

// --- circuit ---------------------------------------------------------------
const TRACK_POINTS = [
  [0, -140], [70, -140], [120, -112], [138, -62],
  [126, -14], [84, 16], [92, 58], [132, 86],
  [120, 132], [62, 148], [4, 138], [-34, 106],
  [-22, 62], [-46, 28], [-96, 26], [-128, -8],
  [-124, -66], [-92, -112], [-44, -140],
];
const SAMPLES = 900;
const HALF_W = 9;            // tarmac half-width
const KERB_W = 2.0;
const WALL_W = 13;           // how far off-centre the barriers sit

// --- car -------------------------------------------------------------------
const TOP = 58;              // m/s on tarmac (~209 km/h)
const OFF_TOP = 21;          // ...and on the grass
const ENGINE = 20;
const BRAKE_F = 34;
const REVERSE_TOP = 11;
// Coasting should shed roughly 2 m/s^2 at motorway speed. An earlier set of
// numbers was so draggy that full throttle balanced out at 79 km/h, nowhere
// near the car's nominal top speed.
const ROLL_CONST = 0.55;     // always-on rolling resistance
const ROLL_DRAG = 0.02;      // linear term
const AIR_DRAG = 0.0004;     // quadratic term
const GRIP = 6.6;
const OFF_GRIP = 2.4;
const STEER_RATE = 2.5;
const CAR_R = 2.1;           // collision radius

const LAPS = 3;
const COLORS = [0x3f7fe8, 0xffd166, 0x59e39b, 0xff8a70, 0xc3a6ff, 0xff9ecb];

const STATE = { COUNT: "count", RACE: "race", DONE: "done" };

export class RacingGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Racing";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.3, 900);
    this.camera2 = new THREE.PerspectiveCamera(62, 16 / 9, 0.3, 900);
    this.cameras = [this.camera];
    this.shake = [0, 0];
    this._buildTrack();
    this._buildScenery();
    this._buildCars();
  }

  // ------------------------------------------------------------ the circuit

  _buildTrack() {
    const pts = TRACK_POINTS.map(p => new THREE.Vector3(p[0], 0, p[1]));
    this.curve = new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.5);

    // Sample once, then everything downstream reads these arrays.
    this.line = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / SAMPLES;
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t).normalize();
      // normal points to the driver's left
      const nrm = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
      this.line.push({ p, tan, nrm, s: 0, curv: 0 });
    }
    let s = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const a = this.line[i].p, b = this.line[(i + 1) % SAMPLES].p;
      this.line[i].s = s;
      s += a.distanceTo(b);
    }
    this.length = s;

    // curvature: how far the tangent swings over a short stretch of road
    const span = 12;
    for (let i = 0; i < SAMPLES; i++) {
      const a = this.line[i].tan;
      const b = this.line[(i + span) % SAMPLES].tan;
      const dot = clamp(a.x * b.x + a.z * b.z, -1, 1);
      this.line[i].curv = Math.acos(dot);
    }

    /*
     * A speed profile for the whole lap, so the computer drivers are quick on
     * the straights and only slow for the corner they are actually reaching.
     *
     * First the cornering limit from the radius (v = sqrt(a * r)), then a
     * backward pass letting each sample be no faster than what can still be
     * scrubbed off before the next one. Several passes carry the braking zone
     * back around the closed loop. An earlier version just scaled speed by the
     * curvature directly, which pinned the field to about 55 km/h everywhere.
     */
    const ds = this.length / SAMPLES;
    const LAT_ACC = 16;        // m/s^2 of grip in a corner
    const BRAKE_ACC = 24;
    for (let i = 0; i < SAMPLES; i++) {
      const c = this.line[i].curv;
      const radius = c > 1e-4 ? (ds * span) / c : 1e6;
      this.line[i].vmax = Math.min(TOP, Math.sqrt(LAT_ACC * radius));
    }
    for (let pass = 0; pass < 4; pass++) {
      for (let i = SAMPLES - 1; i >= 0; i--) {
        const next = this.line[(i + 1) % SAMPLES];
        const allowed = Math.sqrt(next.vmax * next.vmax + 2 * BRAKE_ACC * ds);
        if (this.line[i].vmax > allowed) { this.line[i].vmax = allowed; }
      }
    }

    this.scene.add(this._ribbon(-HALF_W, HALF_W, 0.02, 0x35383f));
    this.scene.add(this._ribbon(-HALF_W - 0.35, -HALF_W + 0.05, 0.04, 0xf2f2f2));
    this.scene.add(this._ribbon(HALF_W - 0.05, HALF_W + 0.35, 0.04, 0xf2f2f2));
    this.scene.add(this._ribbon(-HALF_W - KERB_W, -HALF_W - 0.3, 0.05, 0xd8443a, 0xf5f5f5));
    this.scene.add(this._ribbon(HALF_W + 0.3, HALF_W + KERB_W, 0.05, 0xd8443a, 0xf5f5f5));
    this.scene.add(this._wall(-WALL_W, 1.05, 0x9aa4b8));
    this.scene.add(this._wall(WALL_W, 1.05, 0x9aa4b8));
    this._startLine();
  }

  /** A flat strip between two lateral offsets, optionally striped. */
  _ribbon(a, b, y, colorA, colorB) {
    const pos = [];
    const col = [];
    const ca = new THREE.Color(colorA);
    const cb = new THREE.Color(colorB === undefined ? colorA : colorB);
    for (let i = 0; i < SAMPLES; i++) {
      const A = this.line[i], B = this.line[(i + 1) % SAMPLES];
      const p1 = A.p.clone().addScaledVector(A.nrm, a);
      const p2 = A.p.clone().addScaledVector(A.nrm, b);
      const p3 = B.p.clone().addScaledVector(B.nrm, a);
      const p4 = B.p.clone().addScaledVector(B.nrm, b);
      pos.push(p1.x, y, p1.z, p3.x, y, p3.z, p2.x, y, p2.z);
      pos.push(p2.x, y, p2.z, p3.x, y, p3.z, p4.x, y, p4.z);
      // stripes alternate every few samples so kerbs read at speed
      const c = (Math.floor(i / 6) % 2 === 0) ? ca : cb;
      for (let k = 0; k < 6; k++) { col.push(c.r, c.g, c.b); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.85,
    }));
    mesh.receiveShadow = true;
    return mesh;
  }

  /** A vertical barrier running alongside the track. */
  _wall(offset, height, color) {
    const pos = [];
    for (let i = 0; i < SAMPLES; i++) {
      const A = this.line[i], B = this.line[(i + 1) % SAMPLES];
      const a = A.p.clone().addScaledVector(A.nrm, offset);
      const b = B.p.clone().addScaledVector(B.nrm, offset);
      pos.push(a.x, 0, a.z, b.x, 0, b.z, a.x, height, a.z);
      pos.push(a.x, height, a.z, b.x, 0, b.z, b.x, height, b.z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: color, roughness: 0.7, side: THREE.DoubleSide,
    }));
  }

  _startLine() {
    const A = this.line[0];
    const geo = new THREE.PlaneGeometry(HALF_W * 2, 3);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const g = canvas.getContext("2d");
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        g.fillStyle = (x + y) % 2 ? "#ffffff" : "#20242c";
        g.fillRect(x * 8, y * 8, 8, 8);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(12, 1.5);
    tex.magFilter = THREE.NearestFilter;
    const mesh = new THREE.Mesh(geo,
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = -Math.atan2(A.tan.x, A.tan.z);
    mesh.position.copy(A.p);
    mesh.position.y = 0.06;
    this.scene.add(mesh);

    // a gantry so the line is visible from a distance
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2b3350, roughness: 0.6 });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7, 0.6), postMat);
      post.position.copy(A.p.clone().addScaledVector(A.nrm, side * (HALF_W + 2)));
      post.position.y = 3.5;
      post.castShadow = true;
      this.scene.add(post);
    }
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry((HALF_W + 2) * 2, 1.4, 0.7),
      new THREE.MeshStandardMaterial({ color: 0x1d2740, roughness: 0.6 })
    );
    beam.position.copy(A.p);
    beam.position.y = 7;
    beam.rotation.y = -Math.atan2(A.tan.x, A.tan.z) + Math.PI / 2;
    this.scene.add(beam);
  }

  _buildScenery() {
    this.scene.add(skyDome(0x2f6fc9, 0xcfe6ff));
    this.scene.fog = new THREE.Fog(0xaecde8, 240, 620);
    addLights(this.scene, { shadowRange: 70, sun: 1.35 });

    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(900, 900),
      new THREE.MeshStandardMaterial({ color: 0x3f7a45, roughness: 0.97 })
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -0.03;
    grass.receiveShadow = true;
    this.scene.add(grass);

    // trees, kept clear of the circuit by testing against the centreline
    const trunkGeo = new THREE.CylinderGeometry(0.4, 0.55, 3, 6);
    const leafGeo = new THREE.ConeGeometry(2.6, 6.5, 7);
    const trunks = new THREE.InstancedMesh(trunkGeo,
      new THREE.MeshStandardMaterial({ color: 0x5b3f2a, roughness: 0.95 }), 260);
    const leaves = new THREE.InstancedMesh(leafGeo,
      new THREE.MeshStandardMaterial({ roughness: 0.9 }), 260);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let n = 0;
    let guard = 0;
    while (n < 260 && guard < 6000) {
      guard++;
      const x = (Math.random() - 0.5) * 620;
      const z = (Math.random() - 0.5) * 640;
      if (this._distanceToTrack(x, z) < WALL_W + 9) { continue; }
      const scale = 0.7 + Math.random() * 0.8;
      dummy.position.set(x, 1.5 * scale, z);
      dummy.scale.setScalar(scale);
      dummy.rotation.y = Math.random() * Math.PI;
      dummy.updateMatrix();
      trunks.setMatrixAt(n, dummy.matrix);
      dummy.position.y = 5.2 * scale;
      dummy.updateMatrix();
      leaves.setMatrixAt(n, dummy.matrix);
      color.setHSL(0.28 + Math.random() * 0.07, 0.45, 0.24 + Math.random() * 0.14);
      leaves.setColorAt(n, color);
      n++;
    }
    trunks.count = n;
    leaves.count = n;
    trunks.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    this.scene.add(trunks, leaves);
  }

  /** Rough distance from a world point to the centreline (coarse scan). */
  _distanceToTrack(x, z) {
    let best = Infinity;
    for (let i = 0; i < SAMPLES; i += 6) {
      const p = this.line[i].p;
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < best) { best = d; }
    }
    return Math.sqrt(best);
  }

  // ------------------------------------------------------------ cars

  _carMesh(color) {
    const g = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({
      color: color, roughness: 0.35, metalness: 0.35,
    });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1f2a, roughness: 0.5 });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x8fd0ff, roughness: 0.15, metalness: 0.5,
      transparent: true, opacity: 0.75,
    });

    const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.62, 4.4), paint);
    body.position.y = 0.62;
    body.castShadow = true;
    g.add(body);

    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.34, 1.1), paint);
    nose.position.set(0, 0.42, 2.3);
    nose.castShadow = true;
    g.add(nose);

    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.56, 1.9), glass);
    cabin.position.set(0, 1.16, -0.25);
    g.add(cabin);

    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.12, 0.5), dark);
    spoiler.position.set(0, 1.24, -2.15);
    g.add(spoiler);
    for (const side of [-1, 1]) {
      const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.4, 0.16), dark);
      stalk.position.set(side * 0.8, 1.02, -2.15);
      g.add(stalk);
    }

    const wheelGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.36, 14);
    const wheels = [];
    for (const [x, z] of [[-1.02, 1.4], [1.02, 1.4], [-1.02, -1.45], [1.02, -1.45]]) {
      const w = new THREE.Mesh(wheelGeo, dark);
      w.rotation.z = Math.PI / 2;
      w.position.set(x, 0.46, z);
      w.castShadow = true;
      g.add(w);
      wheels.push(w);
    }
    g.userData.wheels = wheels;
    return g;
  }

  _buildCars() {
    this.cars = [];
    for (let i = 0; i < 6; i++) {
      const mesh = this._carMesh(COLORS[i % COLORS.length]);
      this.scene.add(mesh);
      this.cars.push({
        mesh,
        idx: 0, lap: 0, prevIdx: 0,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        heading: 0,
        speed: 0,
        steer: 0,
        throttle: 0,
        brake: 0,
        offTrack: false,
        slip: 0,
        human: -1,
        skill: 1,
        lineOffset: 0,
        finished: false,
        lapTimes: [],
        lapStart: 0,
        screechAt: 0,
      });
    }
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    this.twoPlayer = this.ctx.humanCount() >= 2;
    this.cameras = this.twoPlayer ? [this.camera, this.camera2] : [this.camera];
    this.humans = this.twoPlayer ? 2 : 1;

    this.state = STATE.COUNT;
    this.countdown = 3.999;
    this.lastBeep = 5;
    this.time = 0;
    this.results = [];

    const start = this.line[0];
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      car.human = i < this.humans ? i : -1;
      car.skill = car.human >= 0 ? 1 : 0.9 + Math.random() * 0.12;
      car.lineOffset = car.human >= 0 ? 0 : (Math.random() - 0.5) * HALF_W * 0.9;
      car.lap = 0;
      car.finished = false;
      car.lapTimes = [];
      car.lapStart = 0;
      car.speed = 0;
      car.throttle = 0;
      car.brake = 0;
      car.steer = 0;
      car.slip = 0;
      car.gasHeld = false;
      car.brakeHeld = false;

      // grid: staggered pairs behind the line
      const row = Math.floor(i / 2);
      const side = (i % 2) ? 1 : -1;
      const back = 6 + row * 8;
      const gridIdx = (SAMPLES - Math.round(back / (this.length / SAMPLES))) % SAMPLES;
      const g = this.line[gridIdx];
      car.pos.copy(g.p).addScaledVector(g.nrm, side * 3.2);
      car.pos.y = 0;
      car.heading = Math.atan2(g.tan.x, g.tan.z);
      car.vel.set(0, 0, 0);
      car.idx = gridIdx;
      car.prevIdx = gridIdx;
      car.mesh.position.copy(car.pos);
      car.mesh.rotation.y = car.heading;
      car.mesh.visible = true;
    }

    this.shake = [0, 0];
    this._brief();
    this._syncHud();
    sfx.resume();
    sfx.engineStart();
    this.ctx.ui.toast("GET READY", this.twoPlayer ? "Player 1 left, player 2 right" : "", 1200);
  }

  exit() {
    sfx.engineStop();
  }

  _brief() {
    const hint = "Hold the phone sideways like a wheel and turn it to steer.";
    for (let i = 0; i < this.humans; i++) {
      const c = this.ctx.seat(i);
      if (!c) { continue; }
      this.ctx.net.mode(c.pid,
        this.twoPlayer ? "Racing - Player " + (i + 1) : "Racing",
        hint, "GAS", "Right = gas, left = brake", "pedals");
    }
  }

  // ------------------------------------------------------------ track queries

  /**
   * Nearest centreline sample, searched near the car's last known index so it
   * stays cheap and cannot jump to the far side of a hairpin.
   */
  _locate(car) {
    let best = car.idx;
    let bestD = Infinity;
    for (let k = -45; k <= 45; k++) {
      const i = (car.idx + k + SAMPLES) % SAMPLES;
      const p = this.line[i].p;
      const d = (p.x - car.pos.x) ** 2 + (p.z - car.pos.z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    car.prevIdx = car.idx;
    car.idx = best;
    const L = this.line[best];
    const dx = car.pos.x - L.p.x, dz = car.pos.z - L.p.z;
    car.lateral = dx * L.nrm.x + dz * L.nrm.z;
    car.offTrack = Math.abs(car.lateral) > HALF_W;

    // lap counting: only when the index wraps the right way round
    if (car.prevIdx > SAMPLES * 0.75 && best < SAMPLES * 0.25) {
      car.lap++;
      if (this.state === STATE.RACE) { this._onLap(car); }
    } else if (car.prevIdx < SAMPLES * 0.25 && best > SAMPLES * 0.75) {
      car.lap--;
    }
  }

  /**
   * Called on each crossing of the start/finish line.
   *
   * The grid sits behind the line, so the very first crossing is the start of
   * lap one rather than the end of it - counting it as a completed lap gave
   * everyone a bogus 1.3 second opening lap.
   */
  _onLap(car) {
    if (car.finished) { return; }
    const t = this.time;

    if (car.lap <= 1) {
      car.lapStart = t;
      return;
    }

    car.lapTimes.push(t - car.lapStart);
    car.lapStart = t;

    if (car.lap > LAPS) {
      car.finished = true;
      car.finishTime = t;
      this.results.push(car);
      if (car.human >= 0) {
        const place = this.results.length;
        this.ctx.ui.toast(ordinal(place), "Finished in " + fmtTime(t), 5000);
        sfx.cheer(place === 1 ? 1 : 0.4);
        this.ctx.net.buzz(this._pidOf(car), 240);
      }
      if (this._humansDone()) {
        this.state = STATE.DONE;
        this.doneAt = this.time;
      }
      return;
    }

    if (car.human >= 0) {
      sfx.point(true);
      this.ctx.net.buzz(this._pidOf(car), 60);
      const best = Math.min(...car.lapTimes);
      const last = car.lapTimes[car.lapTimes.length - 1];
      this.ctx.ui.toast("LAP " + car.lap,
        fmtTime(last) + (last <= best ? "  -  best lap" : ""), 1800);
    }
  }

  _humansDone() {
    return this.cars.filter(c => c.human >= 0).every(c => c.finished);
  }

  _pidOf(car) {
    const c = this.ctx.seat(car.human);
    return c ? c.pid : 0;
  }

  _progress(car) {
    return car.lap * SAMPLES + car.idx;
  }

  _placeOf(car) {
    let place = 1;
    const mine = this._progress(car);
    for (const other of this.cars) {
      if (other === car) { continue; }
      if (other.finished && !car.finished) { place++; continue; }
      if (this._progress(other) > mine) { place++; }
    }
    return place;
  }

  // ------------------------------------------------------------ input

  onButton(down, pid, key) {
    const seat = this.ctx.seatOf(pid);
    if (seat < 0 || seat >= this.humans) { return; }
    const car = this.cars[seat];
    if (key === "gas") { car.gasHeld = down; }
    else if (key === "brake") { car.brakeHeld = down; }
    else if (key === "a") { car.gasHeld = down; }   // single-button fallback
  }

  onSwing() { /* racing does not use swings */ }

  // ------------------------------------------------------------ update

  update(dt, time) {
    if (this.state === STATE.COUNT) {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown);
      if (n < this.lastBeep && n >= 0) {
        this.lastBeep = n;
        if (n > 0) { sfx.countdown(false); this.ctx.ui.toast(String(n), "", 700); }
        else {
          sfx.countdown(true);
          this.ctx.ui.toast("GO!", "", 900);
          this.state = STATE.RACE;
          for (const car of this.cars) { car.lapStart = 0; }
        }
      }
    } else if (this.state === STATE.RACE) {
      this.time += dt;
    } else if (this.state === STATE.DONE) {
      this.time += dt;
    }

    const racing = this.state !== STATE.COUNT;
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      if (car.human >= 0) { this._humanInput(car, racing); }
      else { this._aiInput(car, racing); }
      this._drive(car, dt);
      this._locate(car);
    }
    this._collide();
    this._animate(dt);
    this._camera(dt);
    this._engineSound();

    if (this.state !== STATE.COUNT && time - (this._hudAt || 0) > 0.08) {
      this._hudAt = time;
      this._syncHud();
    }
    this.ctx.ui.prompt(this.state === STATE.COUNT
      ? "Hold the phone sideways - right pedal is the gas"
      : "");
  }

  _humanInput(car, racing) {
    const c = this.ctx.seat(car.human);
    if (!c) { car.throttle = 0; car.brake = 0; car.steer = 0; return; }
    car.steer = clamp(c.wheel || 0, -1, 1);
    car.throttle = racing && car.gasHeld ? 1 : 0;
    car.brake = racing && car.brakeHeld ? 1 : 0;
  }

  _aiInput(car, racing) {
    const speed = car.speed;
    const ahead = Math.round(9 + speed * 0.55);
    const target = this.line[(car.idx + ahead) % SAMPLES];
    const aim = target.p.clone().addScaledVector(target.nrm, car.lineOffset);

    const want = Math.atan2(aim.x - car.pos.x, aim.z - car.pos.z);
    let diff = want - car.heading;
    while (diff > Math.PI) { diff -= Math.PI * 2; }
    while (diff < -Math.PI) { diff += Math.PI * 2; }
    car.steer = clamp(diff * 2.1, -1, 1);

    // the profile already contains the braking zones, so a short look ahead does
    let limit = Infinity;
    for (let k = 0; k <= 10; k += 2) {
      limit = Math.min(limit, this.line[(car.idx + k) % SAMPLES].vmax);
    }
    const targetSpeed = limit * car.skill;
    if (!racing) { car.throttle = 0; car.brake = 0; return; }
    if (speed < targetSpeed - 1) { car.throttle = 1; car.brake = 0; }
    else if (speed > targetSpeed + 2) { car.throttle = 0; car.brake = 0.75; }
    else { car.throttle = 0.45; car.brake = 0; }
  }

  _drive(car, dt) {
    const fx = Math.sin(car.heading), fz = Math.cos(car.heading);

    // split velocity into "along the car" and "sideways"
    let along = car.vel.x * fx + car.vel.z * fz;
    let latX = car.vel.x - fx * along, latZ = car.vel.z - fz * along;

    const top = car.offTrack ? OFF_TOP : TOP;
    const grip = car.offTrack ? OFF_GRIP : GRIP;

    if (car.throttle > 0) {
      along += ENGINE * car.throttle * clamp(1 - along / top, 0, 1) * dt;
    }
    if (car.brake > 0) {
      if (along > 0.5) { along -= BRAKE_F * car.brake * dt; }
      else { along -= ENGINE * 0.55 * car.brake * dt; }   // into reverse
      if (along < -REVERSE_TOP) { along = -REVERSE_TOP; }
    }
    // rolling and air resistance
    const resist = ROLL_CONST * Math.sign(along)
      + ROLL_DRAG * along + AIR_DRAG * along * Math.abs(along);
    along -= resist * dt;
    if (car.throttle === 0 && car.brake === 0 && Math.abs(along) < 0.35) { along = 0; }

    // steering authority builds with speed then tapers at the top end
    const v = Math.abs(along);
    const authority = clamp(v / 9, 0, 1) * (1 - 0.42 * clamp(v / TOP, 0, 1));
    car.heading += car.steer * STEER_RATE * authority * dt * Math.sign(along || 1);

    // the tyres scrub off sideways speed; less of it on grass, which is the drift
    const keep = Math.exp(-grip * dt);
    latX *= keep; latZ *= keep;

    const nfx = Math.sin(car.heading), nfz = Math.cos(car.heading);
    car.vel.set(nfx * along + latX, 0, nfz * along + latZ);
    car.pos.addScaledVector(car.vel, dt);
    car.speed = along;
    car.slip = Math.hypot(latX, latZ);

    this._walls(car);
  }

  _walls(car) {
    // resolve against the barrier using the lateral offset we already track
    const L = this.line[car.idx];
    const dx = car.pos.x - L.p.x, dz = car.pos.z - L.p.z;
    const lat = dx * L.nrm.x + dz * L.nrm.z;
    if (Math.abs(lat) <= WALL_W - 1.0) { return; }

    const sign = Math.sign(lat);
    const push = Math.abs(lat) - (WALL_W - 1.0);
    car.pos.x -= L.nrm.x * push * sign;
    car.pos.z -= L.nrm.z * push * sign;

    // kill the outward part of the velocity and scrub some speed
    const outward = car.vel.x * L.nrm.x * sign + car.vel.z * L.nrm.z * sign;
    if (outward > 0) {
      car.vel.x -= L.nrm.x * sign * outward * 1.6;
      car.vel.z -= L.nrm.z * sign * outward * 1.6;
      const hit = Math.min(1, Math.abs(outward) / 18);
      if (hit > 0.12) {
        car.vel.multiplyScalar(0.72);
        if (car.human >= 0) {
          this.shake[car.human] = 0.35 + hit * 0.5;
          this.ctx.net.buzz(this._pidOf(car), 80 + hit * 120);
          sfx.crashInto(hit);
        }
      }
    }
  }

  _collide() {
    for (let i = 0; i < this.cars.length; i++) {
      for (let j = i + 1; j < this.cars.length; j++) {
        const a = this.cars[i], b = this.cars[j];
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > CAR_R * 2 || d < 1e-4) { continue; }
        const nx = dx / d, nz = dz / d;
        const overlap = CAR_R * 2 - d;
        a.pos.x -= nx * overlap * 0.5; a.pos.z -= nz * overlap * 0.5;
        b.pos.x += nx * overlap * 0.5; b.pos.z += nz * overlap * 0.5;

        const rel = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
        if (rel >= 0) { continue; }
        const imp = -rel * 0.55;
        a.vel.x -= nx * imp; a.vel.z -= nz * imp;
        b.vel.x += nx * imp; b.vel.z += nz * imp;
        if (Math.abs(rel) > 4) {
          sfx.crashInto(Math.min(1, Math.abs(rel) / 22));
          for (const car of [a, b]) {
            if (car.human >= 0) {
              this.shake[car.human] = 0.3;
              this.ctx.net.buzz(this._pidOf(car), 70);
            }
          }
        }
      }
    }
  }

  _animate(dt) {
    const now = performance.now();
    for (const car of this.cars) {
      car.mesh.position.set(car.pos.x, 0, car.pos.z);
      car.mesh.rotation.y = car.heading;
      // lean into the corner a little
      const leanTarget = -car.steer * clamp(Math.abs(car.speed) / TOP, 0, 1) * 0.11;
      car.mesh.rotation.z = damp(car.mesh.rotation.z, leanTarget, 7, dt);
      car.mesh.rotation.x = damp(car.mesh.rotation.x,
        clamp(-car.throttle * 0.02 + car.brake * 0.035, -0.05, 0.05), 6, dt);

      const spin = car.speed * dt / 0.46;
      for (let i = 0; i < car.mesh.userData.wheels.length; i++) {
        const w = car.mesh.userData.wheels[i];
        w.rotation.x -= spin;
        if (i < 2) { w.rotation.y = car.steer * 0.5; }
      }

      // tyre noise when sliding, throttled so it does not machine-gun
      if (car.human >= 0 && car.slip > 5 && now - car.screechAt > 180) {
        car.screechAt = now;
        sfx.screech(clamp(car.slip / 16, 0, 1));
      }
    }
  }

  _camera(dt) {
    for (let i = 0; i < this.cameras.length; i++) {
      const car = this.cars[i];
      const cam = this.cameras[i];
      const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
      // sit further back the faster you go
      const back = 9 + clamp(Math.abs(car.speed) / TOP, 0, 1) * 3.5;
      const want = new THREE.Vector3(
        car.pos.x - fx * back, 4.0 + clamp(Math.abs(car.speed) / TOP, 0, 1) * 0.9,
        car.pos.z - fz * back);
      cam.position.x = damp(cam.position.x, want.x, 6, dt);
      cam.position.y = damp(cam.position.y, want.y, 6, dt);
      cam.position.z = damp(cam.position.z, want.z, 6, dt);

      if (this.shake[i] > 0.001) {
        this.shake[i] *= Math.exp(-6 * dt);
        cam.position.x += (Math.random() - 0.5) * this.shake[i];
        cam.position.y += (Math.random() - 0.5) * this.shake[i];
      }
      cam.lookAt(car.pos.x + fx * 9, 1.6, car.pos.z + fz * 9);
    }
  }

  _engineSound() {
    const car = this.cars[0];
    if (!car) { return; }
    const revs = clamp(Math.abs(car.speed) / TOP, 0, 1);
    sfx.engineSet(revs, car.throttle * 0.8 + (car.offTrack ? 0.2 : 0));
  }

  // ------------------------------------------------------------ hud

  _syncHud() {
    const rows = [];
    for (let i = 0; i < this.humans; i++) {
      const car = this.cars[i];
      const kph = Math.max(0, Math.round(car.speed * 3.6));
      const lap = clamp(car.lap, 1, LAPS);
      const best = car.lapTimes.length ? Math.min(...car.lapTimes) : null;
      rows.push(
        '<div class="raceCard">'
        + (this.humans > 1 ? '<span class="tag ' + (i === 0 ? "blue" : "red") + '">P'
          + (i + 1) + '</span>' : '')
        + '<span class="pos">' + ordinal(this._placeOf(car)) + '</span>'
        + '<span class="speedo"><b>' + kph + '</b><i>km/h</i></span>'
        + '<span class="lapbox">LAP <b>' + lap + '</b>/' + LAPS + '</span>'
        + '<span class="timebox">' + fmtTime(this.time)
        + (best ? ' <i>best ' + fmtTime(best) + '</i>' : '') + '</span>'
        + (car.offTrack ? '<span class="warn">OFF TRACK</span>' : '')
        + '</div>');
    }
    this.ctx.ui.hud('<div class="raceHud">' + rows.join("") + '</div>');
  }

  render(renderer) {
    renderSplit(renderer, this.scene, this.cameras);
  }
}

function fmtTime(t) {
  if (!isFinite(t)) { return "--:--"; }
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m + ":" + (s < 10 ? "0" : "") + s.toFixed(2);
}

function ordinal(n) {
  const suffix = (n % 10 === 1 && n % 100 !== 11) ? "st"
    : (n % 10 === 2 && n % 100 !== 12) ? "nd"
      : (n % 10 === 3 && n % 100 !== 13) ? "rd" : "th";
  return n + suffix;
}
