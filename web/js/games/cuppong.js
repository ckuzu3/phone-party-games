/*
 * Cup pong.
 *
 * Tilt to aim, swing to throw. The ball is a projectile that can bounce once
 * off the table, so both the direct arc and the bounce shot work.
 *
 * A cup counts when the ball drops through its mouth while moving downward -
 * checked as a circle test at the rim height, the same idea as the basketball
 * hoop but with ten of them.
 */

import * as THREE from "../../lib/three.module.js";
import { addLights, skyDome, blobShadow, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";

const G = 9.81;
const BALL_R = 0.02;
const CUP_R = 0.047;
const CUP_H = 0.12;
const TABLE_Y = 0.76;
const TABLE_LEN = 2.44;
const TABLE_W = 0.76;
const THROW_Z = TABLE_LEN / 2 + 0.35;

export class CupPongGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Cup Pong";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.02, 60);
    this.cameras = [this.camera];
    this.cupMeshes = [];
    this._build();
  }

  _build() {
    const scene = this.scene;
    scene.add(skyDome(0x14182a, 0x3d4560));
    addLights(scene, { sky: 0xd8e4ff, ground: 0x2a2f40, ambient: 0.95, sun: 1.1,
                       shadowRange: 4 });
    const lamp = new THREE.PointLight(0xffe8c0, 12, 8, 2);
    lamp.position.set(0, TABLE_Y + 1.8, 0);
    scene.add(lamp);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 24),
      new THREE.MeshStandardMaterial({ color: 0x24283a, roughness: 0.96 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const top = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE_W, 0.04, TABLE_LEN),
      new THREE.MeshStandardMaterial({ color: 0x1f6b4a, roughness: 0.55 })
    );
    top.position.y = TABLE_Y;
    top.receiveShadow = true;
    scene.add(top);

    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE_W + 0.05, 0.06, TABLE_LEN + 0.05),
      new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 })
    );
    edge.position.y = TABLE_Y - 0.03;
    scene.add(edge);

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(
          new THREE.BoxGeometry(0.06, TABLE_Y, 0.06),
          new THREE.MeshStandardMaterial({ color: 0x39405a, roughness: 0.8 })
        );
        leg.position.set(sx * (TABLE_W / 2 - 0.06), TABLE_Y / 2, sz * (TABLE_LEN / 2 - 0.06));
        leg.castShadow = true;
        scene.add(leg);
      }
    }

    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 14, 12),
      new THREE.MeshStandardMaterial({ color: 0xfdfdf5, roughness: 0.5 })
    );
    this.ball.castShadow = true;
    scene.add(this.ball);
    this.ballShadow = blobShadow(0.09);
    scene.add(this.ballShadow);

    this.guide = new THREE.Mesh(
      new THREE.PlaneGeometry(0.012, 1.1),
      new THREE.MeshBasicMaterial({
        color: 0x7fe3ff, transparent: true, opacity: 0.35, depthWrite: false,
      })
    );
    this.guide.rotation.x = -Math.PI / 2;
    scene.add(this.guide);
  }

  /** Ten cups in a triangle pointing back at the thrower. */
  _rack() {
    for (const m of this.cupMeshes) { this.scene.remove(m); }
    this.cupMeshes = [];
    this.cups = [];
    const gap = CUP_R * 2 + 0.004;
    const baseZ = -TABLE_LEN / 2 + 0.34;
    let row = 0;
    for (let n = 4; n >= 1; n--) {
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * gap;
        const z = baseZ + row * gap * 0.87;
        const cup = { x, z, alive: true };
        this.cups.push(cup);

        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(CUP_R, CUP_R * 0.72, CUP_H, 18, 1, true),
          new THREE.MeshStandardMaterial({
            color: 0xd0402f, roughness: 0.5, side: THREE.DoubleSide,
          })
        );
        mesh.position.set(x, TABLE_Y + 0.02 + CUP_H / 2, z);
        mesh.castShadow = true;
        this.scene.add(mesh);
        this.cupMeshes.push(mesh);
        cup.mesh = mesh;
      }
      row++;
    }
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    const n = Math.min(2, this.ctx.humanCount());
    this.players = [];
    for (let i = 0; i < n; i++) {
      this.players.push({ seat: i, sunk: 0, thrown: 0 });
    }
    this.active = 0;
    this.over = false;
    this.flight = null;
    this.resetAt = 0;
    this.aimYaw = 0;
    this._rack();
    this._brief();
    this._syncHud();
    this.ctx.ui.toast("CUP PONG",
      n > 1 ? "Take turns - clear all ten to win" : "Sink all ten cups", 2000);
  }

  exit() { }

  _brief() {
    for (let i = 0; i < this.players.length; i++) {
      const c = this.ctx.seat(i);
      if (!c) { continue; }
      this.ctx.net.mode(c.pid,
        this.players.length > 1 ? "Cup Pong - P" + (i + 1) : "Cup Pong",
        "Tilt to aim, swing to throw. A bounce off the table counts too.",
        "THROW", "Swing to throw the ball");
    }
  }

  onSwing(swing) {
    if (this.over || this.flight || this.resetAt) { return; }
    const seat = this.ctx.seatOf(swing.pid);
    if (seat !== this.active || seat < 0) { return; }
    if (swing.power < 0.1) { return; }

    const angle = clamp(38 + swing.lean * 18, 18, 62) * Math.PI / 180;
    const speed = 2.6 + swing.power * 2.6;
    const yaw = this.aimYaw;
    this.flight = {
      pos: new THREE.Vector3(Math.sin(yaw) * 0.05, TABLE_Y + 0.32, THROW_Z),
      vel: new THREE.Vector3(
        Math.sin(yaw) * Math.cos(angle) * speed,
        Math.sin(angle) * speed,
        -Math.cos(yaw) * Math.cos(angle) * speed),
      bounces: 0, done: false, t: 0,
    };
    this.players[this.active].thrown++;
    sfx.whoosh();
    this.ctx.net.buzz(swing.pid, 20);
  }

  _step(dt) {
    const f = this.flight;
    f.t += dt;
    const prevY = f.pos.y;
    f.vel.y -= G * dt;
    f.pos.addScaledVector(f.vel, dt);

    const rimY = TABLE_Y + 0.02 + CUP_H;

    // dropping through a cup mouth
    if (prevY > rimY && f.pos.y <= rimY && f.vel.y < 0) {
      for (const cup of this.cups) {
        if (!cup.alive) { continue; }
        if (Math.hypot(f.pos.x - cup.x, f.pos.z - cup.z) < CUP_R - BALL_R * 0.4) {
          this._sink(cup);
          return;
        }
      }
    }

    // glancing off the outside of a standing cup
    for (const cup of this.cups) {
      if (!cup.alive) { continue; }
      if (f.pos.y > rimY || f.pos.y < TABLE_Y) { continue; }
      const dx = f.pos.x - cup.x, dz = f.pos.z - cup.z;
      const d = Math.hypot(dx, dz);
      if (d < CUP_R + BALL_R && d > 0.0001) {
        const nx = dx / d, nz = dz / d;
        const along = f.vel.x * nx + f.vel.z * nz;
        if (along < 0) {
          f.vel.x -= 2 * along * nx * 0.6;
          f.vel.z -= 2 * along * nz * 0.6;
          f.pos.x = cup.x + nx * (CUP_R + BALL_R);
          f.pos.z = cup.z + nz * (CUP_R + BALL_R);
          sfx.noise(0.06, 1600, { gain: 0.1, q: 2 });
        }
      }
    }

    // table
    const onTable = Math.abs(f.pos.x) < TABLE_W / 2 && Math.abs(f.pos.z) < TABLE_LEN / 2;
    if (onTable && f.pos.y - BALL_R <= TABLE_Y + 0.02 && f.vel.y < 0) {
      f.pos.y = TABLE_Y + 0.02 + BALL_R;
      f.vel.y = -f.vel.y * 0.72;
      f.vel.x *= 0.88; f.vel.z *= 0.88;
      f.bounces++;
      sfx.bounce(0.35);
    }

    if (f.pos.y < 0.05 || f.t > 6 || Math.abs(f.pos.z) > TABLE_LEN) { this._miss(); }
  }

  _sink(cup) {
    cup.alive = false;
    this.scene.remove(cup.mesh);
    const p = this.players[this.active];
    p.sunk++;
    this.flight = null;
    const left = this.cups.filter(c => c.alive).length;
    const who = this.players.length > 1 ? "P" + (this.active + 1) + " " : "";
    sfx.splash();
    sfx.point(true);
    this.ctx.net.buzz(this._pid(), 130);

    if (left === 0) {
      this.over = true;
      this.ctx.ui.toast(this.players.length > 1
        ? "PLAYER " + (this.active + 1) + " WINS" : "ALL CLEARED!",
        p.sunk + " cups in " + p.thrown + " throws", 9000);
      sfx.cheer(1);
    } else {
      this.ctx.ui.toast(who + "SUNK IT", left + " left  ·  throw again", 1400);
      // sinking earns another throw
      this.resetAt = performance.now() + 900;
      this.keepTurn = true;
    }
    this._syncHud();
  }

  _miss() {
    this.flight = null;
    this.resetAt = performance.now() + 800;
    this.keepTurn = false;
    sfx.point(false);
  }

  _pid() {
    const c = this.ctx.seat(this.active);
    return c ? c.pid : 0;
  }

  update(dt, time) {
    const c = this.ctx.seat(this.active);
    if (c && !this.flight && !this.over) {
      this.aimYaw = damp(this.aimYaw, clamp(c.aim, -1, 1) * 0.2, 8, dt);
    }

    if (this.flight) {
      this._step(dt);
      if (this.flight) {
        this.ball.position.copy(this.flight.pos);
        this.ball.visible = true;
      }
    } else {
      this.ball.position.set(Math.sin(this.aimYaw) * 0.05, TABLE_Y + 0.32, THROW_Z);
      this.ball.position.y += Math.sin(time * 3) * 0.012;
      this.ball.visible = !this.over;
    }

    if (this.resetAt && performance.now() > this.resetAt) {
      this.resetAt = 0;
      if (!this.keepTurn && this.players.length > 1) { this.active = 1 - this.active; }
      this._syncHud();
    }

    this.ballShadow.position.set(this.ball.position.x, TABLE_Y + 0.03, this.ball.position.z);
    this.ballShadow.visible = this.ball.visible
      && Math.abs(this.ball.position.x) < TABLE_W / 2
      && Math.abs(this.ball.position.z) < TABLE_LEN / 2;

    const aiming = !this.flight && !this.over;
    this.guide.visible = aiming;
    if (aiming) {
      this.guide.position.set(Math.sin(this.aimYaw) * 0.55, TABLE_Y + 0.03,
        THROW_Z - 0.6 - Math.cos(this.aimYaw) * 0.02);
      this.guide.rotation.z = -this.aimYaw;
    }

    // the camera leans with the aim so you can see where you are pointing
    this.camera.position.set(Math.sin(this.aimYaw) * 0.25, TABLE_Y + 0.62, THROW_Z + 0.75);
    this.camera.lookAt(0, TABLE_Y + 0.05, -TABLE_LEN / 4);

    this.ctx.ui.prompt(this.over ? ""
      : this.players.length > 1 ? "Player " + (this.active + 1) + " to throw"
        : "Tilt to aim, swing to throw");
  }

  _syncHud() {
    const left = this.cups ? this.cups.filter(c => c.alive).length : 10;
    const cards = this.players.map((p, i) =>
      '<div class="shotCard' + (i === this.active && !this.over ? " on" : "") + '">'
      + (this.players.length > 1 ? '<span class="tag ' + (i ? "red" : "blue")
         + '">P' + (i + 1) + "</span>" : "")
      + '<span class="big">' + p.sunk + '</span>'
      + '<span class="sub">' + p.thrown + " thrown</span></div>").join("");
    this.ctx.ui.hud('<div class="shotHud">' + cards + '</div>'
      + '<div class="hudSub">' + left + ' cups standing</div>');
  }
}
