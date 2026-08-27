/*
 * Billiards.
 *
 * Tilt to swing the cue around the white, then swing the phone to strike.
 * Pot a ball and you shoot again; miss and the turn passes.
 *
 * The physics is the usual pool model: equal-mass elastic collisions resolved
 * along the line of centres, cushions as reflections, and rolling friction.
 * Everything is sub-stepped so a hard break cannot tunnel balls through each
 * other or through a cushion.
 */

import * as THREE from "../../lib/three.module.js";
import { addLights, skyDome, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";

const BALL_R = 0.0286;        // real pool ball, in metres
const HALF_W = 0.635;         // playing surface, 7ft table
const HALF_L = 1.27;
const POCKET_R = 0.055;
const FRICTION = 0.72;
const STOP = 0.015;
const CUSHION = 0.92;         // energy kept off a cushion

const COLORS = [0xf5f2e8, 0xf2c53d, 0x2f6fe0, 0xd0402f, 0x8a4fd0, 0xe07a2f,
                0x2f8f56, 0x8a3a2f, 0x1b1b22, 0xf2c53d, 0x2f6fe0, 0xd0402f,
                0x8a4fd0, 0xe07a2f, 0x2f8f56];

export class BilliardsGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Billiards";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(44, 16 / 9, 0.02, 60);
    this.cameras = [this.camera];
    this.ballMeshes = [];
    this._build();
  }

  _build() {
    const scene = this.scene;
    scene.add(skyDome(0x14182a, 0x39405a));
    addLights(scene, { sky: 0xdfe8ff, ground: 0x1a3324, ambient: 0.9, sun: 1.0,
                       shadowRange: 3 });
    const lamp = new THREE.PointLight(0xffeccc, 14, 6, 2);
    lamp.position.set(0, 1.7, 0);
    scene.add(lamp);

    const cloth = new THREE.Mesh(
      new THREE.BoxGeometry(HALF_W * 2, 0.04, HALF_L * 2),
      new THREE.MeshStandardMaterial({ color: 0x1f7a4a, roughness: 0.95 })
    );
    cloth.position.y = -0.02;
    cloth.receiveShadow = true;
    scene.add(cloth);

    const railMat = new THREE.MeshStandardMaterial({ color: 0x4a2d18, roughness: 0.7 });
    for (const [x, z, w, d] of [
      [0, HALF_L + 0.05, HALF_W + 0.12, 0.05],
      [0, -HALF_L - 0.05, HALF_W + 0.12, 0.05],
      [-HALF_W - 0.05, 0, 0.05, HALF_L + 0.12],
      [HALF_W + 0.05, 0, 0.05, HALF_L + 0.12],
    ]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(w * 2, 0.08, d * 2), railMat);
      rail.position.set(x, 0.02, z);
      rail.castShadow = true;
      scene.add(rail);
    }

    this.pockets = [];
    for (const [px, pz] of [
      [-HALF_W, -HALF_L], [HALF_W, -HALF_L], [-HALF_W, 0], [HALF_W, 0],
      [-HALF_W, HALF_L], [HALF_W, HALF_L],
    ]) {
      this.pockets.push({ x: px, z: pz });
      const hole = new THREE.Mesh(
        new THREE.CylinderGeometry(POCKET_R, POCKET_R, 0.05, 18),
        new THREE.MeshStandardMaterial({ color: 0x08090c, roughness: 1 })
      );
      hole.position.set(px, 0.005, pz);
      scene.add(hole);
    }

    this.cue = new THREE.Mesh(
      new THREE.CylinderGeometry(0.007, 0.013, 1.2, 10),
      new THREE.MeshStandardMaterial({ color: 0xc79a5a, roughness: 0.5 })
    );
    this.cue.rotation.z = Math.PI / 2;
    scene.add(this.cue);

    this.aimLine = new THREE.Mesh(
      new THREE.PlaneGeometry(0.004, 1.0),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false,
      })
    );
    this.aimLine.rotation.x = -Math.PI / 2;
    scene.add(this.aimLine);

    this.camera.position.set(0, 1.85, 1.5);
    this.camera.lookAt(0, 0, 0);
  }

  _rack() {
    for (const m of this.ballMeshes) { this.scene.remove(m); }
    this.ballMeshes = [];
    this.balls = [];

    const add = (x, z, idx) => {
      const b = { x, z, vx: 0, vz: 0, idx, potted: false };
      this.balls.push(b);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(BALL_R, 16, 12),
        new THREE.MeshStandardMaterial({
          color: COLORS[idx], roughness: 0.18, metalness: 0.05,
        })
      );
      mesh.castShadow = true;
      this.scene.add(mesh);
      this.ballMeshes.push(mesh);
      b.mesh = mesh;
      return b;
    };

    this.cueBall = add(0, HALF_L * 0.5, 0);

    // a standard triangle at the far end
    const apexZ = -HALF_L * 0.45;
    const gap = BALL_R * 2 + 0.0008;
    let idx = 1;
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i <= row; i++) {
        const x = (i - row / 2) * gap;
        const z = apexZ - row * gap * 0.866;
        add(x, z, idx++);
      }
    }
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    const n = Math.min(2, this.ctx.humanCount());
    this.players = [];
    for (let i = 0; i < n; i++) { this.players.push({ seat: i, potted: 0, shots: 0 }); }
    this.active = 0;
    this.over = false;
    this.moving = false;
    this.aim = Math.PI;
    this.power = 0;
    this.settleAt = 0;
    this.pottedThisShot = 0;
    this.scratched = false;
    this._rack();
    this._brief();
    this._syncHud();
    this.ctx.ui.toast("BILLIARDS",
      n > 1 ? "Pot a ball to shoot again" : "Clear the table", 2000);
  }

  exit() { }

  _brief() {
    for (let i = 0; i < this.players.length; i++) {
      const c = this.ctx.seat(i);
      if (!c) { continue; }
      this.ctx.net.mode(c.pid,
        this.players.length > 1 ? "Billiards - P" + (i + 1) : "Billiards",
        "Tilt to swing the cue around, then swing the phone to strike.",
        "STRIKE", "Swing to play the shot");
    }
  }

  onSwing(swing) {
    if (this.over || this.moving) { return; }
    const seat = this.ctx.seatOf(swing.pid);
    if (seat !== this.active || seat < 0) { return; }
    if (swing.power < 0.08) { return; }

    const speed = 0.5 + swing.power * 3.4;
    this.cueBall.vx = Math.sin(this.aim) * speed;
    this.cueBall.vz = Math.cos(this.aim) * speed;
    this.moving = true;
    this.pottedThisShot = 0;
    this.scratched = false;
    this.players[this.active].shots++;
    sfx.pinHit(0.7);
    this.ctx.net.buzz(swing.pid, 35);
    this._syncHud();
  }

  // ------------------------------------------------------------ physics

  _physics(dt) {
    const steps = 8;
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      for (const b of this.balls) {
        if (b.potted) { continue; }
        b.x += b.vx * h;
        b.z += b.vz * h;
        const damp = Math.max(0, 1 - FRICTION * h);
        b.vx *= damp; b.vz *= damp;
        if (Math.hypot(b.vx, b.vz) < STOP) { b.vx = 0; b.vz = 0; }
      }
      this._cushions();
      this._collisions();
      this._pockets();
    }

    if (this.balls.every(b => b.potted || (b.vx === 0 && b.vz === 0))) {
      this.moving = false;
      this._endShot();
    }
  }

  _cushions() {
    for (const b of this.balls) {
      if (b.potted) { continue; }
      if (b.x < -HALF_W + BALL_R) { b.x = -HALF_W + BALL_R; b.vx = Math.abs(b.vx) * CUSHION; this._clack(b); }
      if (b.x > HALF_W - BALL_R) { b.x = HALF_W - BALL_R; b.vx = -Math.abs(b.vx) * CUSHION; this._clack(b); }
      if (b.z < -HALF_L + BALL_R) { b.z = -HALF_L + BALL_R; b.vz = Math.abs(b.vz) * CUSHION; this._clack(b); }
      if (b.z > HALF_L - BALL_R) { b.z = HALF_L - BALL_R; b.vz = -Math.abs(b.vz) * CUSHION; this._clack(b); }
    }
  }

  _clack(b) {
    if (Math.hypot(b.vx, b.vz) > 0.5) { sfx.noise(0.05, 900, { gain: 0.07, q: 2 }); }
  }

  /** Equal masses, so the pair just swap their velocity along the contact line. */
  _collisions() {
    for (let i = 0; i < this.balls.length; i++) {
      const a = this.balls[i];
      if (a.potted) { continue; }
      for (let j = i + 1; j < this.balls.length; j++) {
        const b = this.balls[j];
        if (b.potted) { continue; }
        const dx = b.x - a.x, dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d >= BALL_R * 2 || d < 1e-9) { continue; }

        const nx = dx / d, nz = dz / d;
        const overlap = BALL_R * 2 - d;
        a.x -= nx * overlap * 0.5; a.z -= nz * overlap * 0.5;
        b.x += nx * overlap * 0.5; b.z += nz * overlap * 0.5;

        const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
        if (rel >= 0) { continue; }
        a.vx += nx * rel; a.vz += nz * rel;
        b.vx -= nx * rel; b.vz -= nz * rel;
        if (Math.abs(rel) > 0.4) {
          sfx.noise(0.045, 2200, { gain: clamp(Math.abs(rel) * 0.05, 0.03, 0.16), q: 3 });
        }
      }
    }
  }

  _pockets() {
    for (const b of this.balls) {
      if (b.potted) { continue; }
      for (const p of this.pockets) {
        if (Math.hypot(b.x - p.x, b.z - p.z) < POCKET_R) {
          b.potted = true;
          b.vx = 0; b.vz = 0;
          b.mesh.visible = false;
          if (b === this.cueBall) { this.scratched = true; }
          else { this.pottedThisShot++; this.players[this.active].potted++; }
          sfx.noise(0.18, 320, { gain: 0.16, q: 0.8, filter: "lowpass" });
          break;
        }
      }
    }
  }

  _endShot() {
    const left = this.balls.filter(b => b !== this.cueBall && !b.potted).length;

    if (this.scratched) {
      // back on the table, and the turn passes
      this.cueBall.potted = false;
      this.cueBall.mesh.visible = true;
      this.cueBall.x = 0; this.cueBall.z = HALF_L * 0.5;
      this.cueBall.vx = 0; this.cueBall.vz = 0;
      this.ctx.ui.toast("SCRATCH", "cue ball down - turn passes", 1600);
      sfx.point(false);
      if (this.players.length > 1) { this.active = 1 - this.active; }
    } else if (this.pottedThisShot > 0) {
      const who = this.players.length > 1 ? "P" + (this.active + 1) + " " : "";
      this.ctx.ui.toast(who + (this.pottedThisShot > 1
        ? this.pottedThisShot + " DOWN!" : "POTTED"), "shoot again", 1400);
      sfx.point(true);
    } else {
      if (this.players.length > 1) { this.active = 1 - this.active; }
    }

    if (left === 0) {
      this.over = true;
      const ranked = [...this.players].sort((a, b) => b.potted - a.potted);
      this.ctx.ui.toast(
        this.players.length > 1 ? "PLAYER " + (ranked[0].seat + 1) + " WINS"
          : "TABLE CLEARED",
        ranked[0].potted + " balls in " + ranked[0].shots + " shots", 10000);
      sfx.cheer(1);
    }
    this._syncHud();
  }

  update(dt, time) {
    const c = this.ctx.seat(this.active);
    if (c && !this.moving && !this.over) {
      this.aim += clamp(c.aim, -1, 1) * 1.6 * dt;
    }

    if (this.moving) { this._physics(dt); }

    for (const b of this.balls) {
      if (b.potted) { continue; }
      b.mesh.position.set(b.x, BALL_R, b.z);
    }

    const aiming = !this.moving && !this.over;
    this.cue.visible = aiming;
    this.aimLine.visible = aiming;
    if (aiming) {
      const cx = this.cueBall.x, cz = this.cueBall.z;
      const bx = -Math.sin(this.aim), bz = -Math.cos(this.aim);
      this.cue.position.set(cx + bx * 0.65, BALL_R, cz + bz * 0.65);
      this.cue.rotation.set(0, 0, Math.PI / 2);
      this.cue.rotation.y = this.aim + Math.PI / 2;
      this.aimLine.position.set(cx + Math.sin(this.aim) * 0.5, 0.004,
        cz + Math.cos(this.aim) * 0.5);
      this.aimLine.rotation.z = -this.aim;
    }

    this.ctx.ui.prompt(this.over ? "" : this.moving ? ""
      : this.players.length > 1 ? "Player " + (this.active + 1) + " to play"
        : "Tilt to aim, swing to strike");
  }

  _syncHud() {
    const left = this.balls ? this.balls.filter(b => b !== this.cueBall && !b.potted).length : 15;
    const cards = this.players.map((p, i) =>
      '<div class="shotCard' + (i === this.active && !this.over ? " on" : "") + '">'
      + (this.players.length > 1 ? '<span class="tag ' + (i ? "red" : "blue")
         + '">P' + (i + 1) + "</span>" : "")
      + '<span class="big">' + p.potted + '</span>'
      + '<span class="sub">' + p.shots + " shots</span></div>").join("");
    this.ctx.ui.hud('<div class="shotHud">' + cards + '</div>'
      + '<div class="hudSub">' + left + ' balls on the table</div>');
  }
}
