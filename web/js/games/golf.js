/*
 * Mini golf - nine holes.
 *
 * Tilt to swing the aim line around, then swing the phone to putt. Power comes
 * from how hard you swing; the line shows the direction and a bar shows how
 * much you are about to hit it.
 *
 * The ball rolls in two dimensions with friction, reflects off the walls, and
 * drops in when it reaches the cup slowly enough. Holes are described as a
 * list of axis-aligned boxes, which keeps the collision handling to one case.
 */

import * as THREE from "../../lib/three.module.js";
import { addLights, skyDome, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";

const BALL_R = 0.11;
const CUP_R = 0.28;
const FRICTION = 0.62;        // per second, proportional to speed
const STOP_SPEED = 0.22;
const MAX_SPEED = 11;
const CAPTURE_SPEED = 3.4;    // any faster and the ball rattles out

// Each hole: where you tee off, where the cup is, the walls that bound it, and
// any blocks in the way. Everything is [x, z, halfWidth, halfDepth].
const HOLES = [
  { par: 2, tee: [0, 5], cup: [0, -4],
    walls: [[0, 6.2, 2.2, 0.3], [0, -5.2, 2.2, 0.3], [-2.5, 0.5, 0.3, 6], [2.5, 0.5, 0.3, 6]],
    blocks: [] },
  { par: 3, tee: [-2, 5], cup: [2, -4.2],
    walls: [[0, 6.2, 3.4, 0.3], [0, -5.4, 3.4, 0.3], [-3.7, 0.4, 0.3, 6], [3.7, 0.4, 0.3, 6]],
    blocks: [[0, 1.2, 1.5, 0.35]] },
  { par: 3, tee: [0, 5.4], cup: [0, -4.6],
    walls: [[0, 6.4, 3.4, 0.3], [0, -5.8, 3.4, 0.3], [-3.7, 0.3, 0.3, 6.4], [3.7, 0.3, 0.3, 6.4]],
    blocks: [[-1.6, 1.6, 0.9, 0.35], [1.6, -1.2, 0.9, 0.35]] },
  { par: 4, tee: [-3, 5], cup: [3, -4],
    walls: [[0, 6.2, 4.2, 0.3], [0, -5.2, 4.2, 0.3], [-4.5, 0.5, 0.3, 6], [4.5, 0.5, 0.3, 6]],
    blocks: [[0, 3, 0.4, 1.6], [0, -1.6, 0.4, 2.2]] },
  { par: 3, tee: [0, 5.6], cup: [0, -4.8],
    walls: [[0, 6.5, 3, 0.3], [0, -6, 3, 0.3], [-3.3, 0.3, 0.3, 6.5], [3.3, 0.3, 0.3, 6.5]],
    blocks: [[0, 0.6, 1.5, 0.35]] },
  { par: 4, tee: [3, 5.2], cup: [-3, -4.4],
    walls: [[0, 6.4, 4.4, 0.3], [0, -5.6, 4.4, 0.3], [-4.7, 0.4, 0.3, 6.2], [4.7, 0.4, 0.3, 6.2]],
    blocks: [[1.2, 2, 0.35, 2], [-1.2, -1.4, 0.35, 2]] },
  { par: 4, tee: [-3.4, 5], cup: [3.4, 4.4],
    walls: [[0, 6.2, 4.4, 0.3], [0, -5.2, 4.4, 0.3], [-4.7, 0.5, 0.3, 6], [4.7, 0.5, 0.3, 6]],
    // the upper gap has to clear the ball comfortably: the rail's inner face
    // is at z 5.9, so this block stops well short of it
    blocks: [[0, 3.6, 0.35, 1.2], [0, -0.5, 3, 0.35]] },
  { par: 4, tee: [0, 5.4], cup: [0, -4.6],
    walls: [[0, 6.4, 4, 0.3], [0, -5.8, 4, 0.3], [-4.3, 0.3, 0.3, 6.4], [4.3, 0.3, 0.3, 6.4]],
    blocks: [[-2, 2.4, 1.4, 0.35], [2, 0, 1.4, 0.35], [-2, -2.4, 1.4, 0.35]] },
  { par: 5, tee: [-3.6, 5.2], cup: [3.6, -4.4],
    walls: [[0, 6.4, 4.6, 0.3], [0, -5.6, 4.6, 0.3], [-4.9, 0.4, 0.3, 6.2], [4.9, 0.4, 0.3, 6.2]],
    blocks: [[-1.4, 2.6, 0.35, 1.8], [1.4, 0.2, 0.35, 1.8], [-1.4, -2.6, 0.35, 1.6]] },
];

export class GolfGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Mini Golf";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.05, 120);
    this.cameras = [this.camera];
    this.courseMeshes = [];
    this._build();
  }

  _build() {
    const scene = this.scene;
    scene.add(skyDome(0x3b6bb0, 0xbcd9f0));
    addLights(scene, { sky: 0xd8e8ff, ground: 0x3a5a2a, ambient: 1.0, sun: 1.3,
                       shadowRange: 12 });

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: 0x4a7a38, roughness: 0.96 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.08;
    ground.receiveShadow = true;
    scene.add(ground);

    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 18, 14),
      new THREE.MeshStandardMaterial({ color: 0xfdfdf8, roughness: 0.35 })
    );
    this.ball.castShadow = true;
    scene.add(this.ball);

    this.cup = new THREE.Mesh(
      new THREE.CylinderGeometry(CUP_R, CUP_R, 0.06, 24),
      new THREE.MeshStandardMaterial({ color: 0x10160f, roughness: 1 })
    );
    scene.add(this.cup);

    this.flag = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 1.4, 8),
      new THREE.MeshStandardMaterial({ color: 0xf0f0f0 })
    );
    pole.position.y = 0.7;
    this.flag.add(pole);
    const cloth = new THREE.Mesh(
      new THREE.PlaneGeometry(0.42, 0.26),
      new THREE.MeshStandardMaterial({ color: 0xd0402f, side: THREE.DoubleSide })
    );
    cloth.position.set(0.21, 1.24, 0);
    this.flag.add(cloth);
    scene.add(this.flag);

    this.aimLine = new THREE.Mesh(
      new THREE.PlaneGeometry(0.05, 3),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false,
      })
    );
    this.aimLine.rotation.x = -Math.PI / 2;
    scene.add(this.aimLine);

    this.camera.position.set(0, 11, 9);
    this.camera.lookAt(0, 0, 0.5);
  }

  _buildHole(h) {
    for (const m of this.courseMeshes) { this.scene.remove(m); }
    this.courseMeshes = [];

    const green = new THREE.Mesh(
      new THREE.BoxGeometry(11, 0.12, 13),
      new THREE.MeshStandardMaterial({ color: 0x2f7d43, roughness: 0.92 })
    );
    green.position.set(0, -0.06, 0.4);
    green.receiveShadow = true;
    this.scene.add(green);
    this.courseMeshes.push(green);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.85 });
    for (const box of h.walls.concat(h.blocks)) {
      const [x, z, hw, hd] = box;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(hw * 2, 0.34, hd * 2), wallMat);
      mesh.position.set(x, 0.17, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.courseMeshes.push(mesh);
    }

    this.cup.position.set(h.cup[0], 0.02, h.cup[1]);
    this.flag.position.set(h.cup[0], 0.02, h.cup[1]);
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    const n = Math.min(2, this.ctx.humanCount());
    this.players = [];
    for (let i = 0; i < n; i++) {
      this.players.push({ seat: i, total: 0, strokes: 0, holed: false, scores: [] });
    }
    this.active = 0;
    this.holeIdx = 0;
    this.over = false;
    this.aim = 0;
    this.rolling = false;
    this.nextAt = 0;
    this._startHole();
    this._brief();
    this._syncHud();
    this.ctx.ui.toast("MINI GOLF", HOLES.length + " holes  ·  fewest shots wins", 2000);
  }

  exit() { }

  _brief() {
    for (let i = 0; i < this.players.length; i++) {
      const c = this.ctx.seat(i);
      if (!c) { continue; }
      this.ctx.net.mode(c.pid,
        this.players.length > 1 ? "Mini Golf - P" + (i + 1) : "Mini Golf",
        "Tilt to aim the line, then swing to putt. Gentle swings roll shorter.",
        "PUTT", "Swing to hit the ball");
    }
  }

  _startHole() {
    const h = HOLES[this.holeIdx];
    this.hole = h;
    this._buildHole(h);
    for (const p of this.players) { p.strokes = 0; p.holed = false; }
    this.active = 0;
    this.pos = new THREE.Vector2(h.tee[0], h.tee[1]);
    this.vel = new THREE.Vector2(0, 0);
    this.rolling = false;
    this.aim = Math.atan2(h.cup[0] - h.tee[0], h.cup[1] - h.tee[1]);
    this._syncHud();
  }

  onSwing(swing) {
    if (this.over || this.rolling || this.nextAt) { return; }
    const seat = this.ctx.seatOf(swing.pid);
    if (seat !== this.active || seat < 0) { return; }
    if (swing.power < 0.08) { return; }
    const p = this.players[this.active];
    if (p.holed) { return; }

    const speed = clamp(1.6 + swing.power * MAX_SPEED, 1.2, MAX_SPEED);
    this.vel.set(Math.sin(this.aim) * speed, Math.cos(this.aim) * speed);
    this.rolling = true;
    p.strokes++;
    sfx.pinHit(0.5);
    this.ctx.net.buzz(swing.pid, 30);
    this._syncHud();
  }

  /** Push the ball out of any box it has entered and reflect its velocity. */
  _collide() {
    for (const box of this.hole.walls.concat(this.hole.blocks)) {
      const [bx, bz, hw, hd] = box;
      const dx = this.pos.x - bx, dz = this.pos.y - bz;
      const px = hw + BALL_R - Math.abs(dx);
      const pz = hd + BALL_R - Math.abs(dz);
      if (px <= 0 || pz <= 0) { continue; }

      // resolve along whichever axis is least overlapped
      if (px < pz) {
        this.pos.x = bx + Math.sign(dx || 1) * (hw + BALL_R);
        this.vel.x *= -0.72;
      } else {
        this.pos.y = bz + Math.sign(dz || 1) * (hd + BALL_R);
        this.vel.y *= -0.72;
      }
      if (this.vel.length() > 1.2) { sfx.bounce(0.4); }
    }
  }

  _roll(dt) {
    const steps = 4;                 // sub-step so fast putts cannot skip walls
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.pos.addScaledVector(this.vel, h);
      this.vel.multiplyScalar(Math.max(0, 1 - FRICTION * h));
      this._collide();

      const dx = this.pos.x - this.hole.cup[0];
      const dz = this.pos.y - this.hole.cup[1];
      if (Math.hypot(dx, dz) < CUP_R && this.vel.length() < CAPTURE_SPEED) {
        this._holed();
        return;
      }
    }
    if (this.vel.length() < STOP_SPEED) {
      this.vel.set(0, 0);
      this.rolling = false;
      this._afterShot();
    }
  }

  _holed() {
    const p = this.players[this.active];
    p.holed = true;
    p.scores.push(p.strokes);
    p.total += p.strokes;
    this.rolling = false;
    this.vel.set(0, 0);

    const par = this.hole.par;
    const d = p.strokes - par;
    const label = p.strokes === 1 ? "HOLE IN ONE!"
      : d <= -2 ? "EAGLE" : d === -1 ? "BIRDIE" : d === 0 ? "PAR"
        : d === 1 ? "BOGEY" : "+" + d;
    const who = this.players.length > 1 ? "P" + (this.active + 1) + "  " : "";
    this.ctx.ui.toast(who + label, p.strokes + " on a par " + par, 1900);
    sfx.point(true);
    if (d <= 0) { sfx.cheer(p.strokes === 1 ? 1 : 0.5); }
    this.ctx.net.buzz(this._pid(), 140);
    this._afterShot();
  }

  _afterShot() {
    const allDone = this.players.every(p => p.holed);
    if (allDone) {
      this.nextAt = performance.now() + 1800;
      return;
    }
    if (this.players.length > 1) {
      // pass to the other player if they are still going
      const other = 1 - this.active;
      if (!this.players[other].holed) {
        this.active = other;
        this.pos.set(this.hole.tee[0], this.hole.tee[1]);
        this.aim = Math.atan2(this.hole.cup[0] - this.pos.x, this.hole.cup[1] - this.pos.y);
      }
    }
    this._syncHud();
  }

  _pid() {
    const c = this.ctx.seat(this.active);
    return c ? c.pid : 0;
  }

  update(dt, time) {
    const c = this.ctx.seat(this.active);
    if (c && !this.rolling && !this.over) {
      this.aim += clamp(c.aim, -1, 1) * 1.5 * dt;
    }

    if (this.rolling) { this._roll(dt); }

    if (this.nextAt && performance.now() > this.nextAt) {
      this.nextAt = 0;
      this.holeIdx++;
      if (this.holeIdx >= HOLES.length) { this._finish(); }
      else {
        this.ctx.ui.toast("HOLE " + (this.holeIdx + 1),
          "par " + HOLES[this.holeIdx].par, 1600);
        this._startHole();
      }
    }

    this.ball.position.set(this.pos.x, BALL_R, this.pos.y);
    this.ball.visible = !this.over;
    const cloth = this.flag.children[1];
    cloth.rotation.y = Math.sin(time * 2) * 0.35;

    const aiming = !this.rolling && !this.over;
    this.aimLine.visible = aiming;
    if (aiming) {
      this.aimLine.position.set(
        this.pos.x + Math.sin(this.aim) * 1.6, 0.03,
        this.pos.y + Math.cos(this.aim) * 1.6);
      this.aimLine.rotation.z = -this.aim;
    }

    this.ctx.ui.prompt(this.over ? ""
      : this.rolling ? ""
        : this.players.length > 1
          ? "Player " + (this.active + 1) + " to putt"
          : "Tilt to aim, swing to putt");
  }

  _finish() {
    this.over = true;
    const ranked = [...this.players].sort((a, b) => a.total - b.total);
    const top = ranked[0];
    const par = HOLES.reduce((a, h) => a + h.par, 0);
    if (this.players.length > 1) {
      this.ctx.ui.toast(
        ranked.length > 1 && ranked[0].total === ranked[1].total ? "DRAW"
          : "PLAYER " + (top.seat + 1) + " WINS",
        top.total + " shots for " + HOLES.length + " holes", 10000);
    } else {
      const d = top.total - par;
      this.ctx.ui.toast("ROUND COMPLETE",
        top.total + " shots  ·  " + (d === 0 ? "level par" : (d > 0 ? "+" : "") + d), 10000);
    }
    sfx.cheer(1);
    this._syncHud();
  }

  _syncHud() {
    const par = HOLES[Math.min(this.holeIdx, HOLES.length - 1)].par;
    const cards = this.players.map((p, i) =>
      '<div class="shotCard' + (i === this.active && !this.over ? " on" : "") + '">'
      + (this.players.length > 1 ? '<span class="tag ' + (i ? "red" : "blue")
         + '">P' + (i + 1) + "</span>" : "")
      + '<span class="big">' + p.total + '</span>'
      + '<span class="sub">' + (p.holed ? "holed in " + p.strokes
        : "this hole: " + p.strokes) + '</span></div>').join("");
    this.ctx.ui.hud('<div class="shotHud">' + cards + '</div>'
      + '<div class="hudSub">Hole ' + Math.min(this.holeIdx + 1, HOLES.length)
      + ' of ' + HOLES.length + '  &middot;  par ' + par + '</div>');
  }
}
