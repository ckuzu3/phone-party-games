/*
 * Basketball.
 *
 * Tilt to aim left and right, then swing the phone up and forward to shoot.
 * Swing speed is power; how steeply you lean sets the arc.
 *
 * The ball is a plain projectile, no drag - which keeps the launch-speed solve
 * in onSwing exact. The rim is treated as a real ring: the ball bounces when
 * its centre comes within a ball-radius of that circle, and a shot counts when
 * it crosses the ring's plane on the way down while inside it.
 */

import * as THREE from "../../lib/three.module.js";
import { addLights, skyDome, blobShadow, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";

const G = 9.81;
const BALL_R = 0.122;
const RIM_R = 0.229;
const RIM_Y = 3.05;
const RIM_Z = -6.0;
const ROUND_TIME = 75;

const SPOTS = [
  { x: 0, z: 0, name: "free throw" },
  { x: -2.4, z: 0.6, name: "left wing" },
  { x: 2.4, z: 0.6, name: "right wing" },
  { x: -3.6, z: 2.2, name: "left corner" },
  { x: 3.6, z: 2.2, name: "right corner" },
  { x: 0, z: 2.6, name: "downtown" },
];

export class BasketballGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Basketball";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 300);
    this.cameras = [this.camera];
    this._build();
  }

  _build() {
    const scene = this.scene;
    scene.add(skyDome(0x2b3350, 0x8a94ad));
    addLights(scene, { sky: 0xcfe0ff, ground: 0x6b4a2a, ambient: 0.95, sun: 1.25,
                       shadowRange: 14 });

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: 0xb9793f, roughness: 0.75 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // key + three point arc, painted on
    const paint = new THREE.Mesh(
      new THREE.PlaneGeometry(4.9, 5.8),
      new THREE.MeshStandardMaterial({ color: 0x8a4a2a, roughness: 0.8 })
    );
    paint.rotation.x = -Math.PI / 2;
    paint.position.set(0, 0.01, RIM_Z + 2.9);
    scene.add(paint);

    const arc = new THREE.Mesh(
      new THREE.RingGeometry(6.55, 6.7, 48, 1, Math.PI * 0.15, Math.PI * 0.7),
      new THREE.MeshStandardMaterial({ color: 0xf0e6d8, side: THREE.DoubleSide })
    );
    arc.rotation.x = -Math.PI / 2;
    arc.position.set(0, 0.02, RIM_Z);
    scene.add(arc);

    // backboard, rim and net
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(1.83, 1.07, 0.06),
      new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.2, transparent: true, opacity: 0.55,
      })
    );
    board.position.set(0, RIM_Y + 0.45, RIM_Z - 0.35);
    scene.add(board);
    this.boardZ = RIM_Z - 0.32;

    const inner = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.46, 0.02),
      new THREE.MeshStandardMaterial({ color: 0xd0402f })
    );
    inner.position.set(0, RIM_Y + 0.28, RIM_Z - 0.31);
    scene.add(inner);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(RIM_R, 0.018, 8, 26),
      new THREE.MeshStandardMaterial({ color: 0xff7a2f, roughness: 0.4, metalness: 0.5 })
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(0, RIM_Y, RIM_Z);
    rim.castShadow = true;
    scene.add(rim);

    const net = new THREE.Mesh(
      new THREE.CylinderGeometry(RIM_R * 0.95, RIM_R * 0.55, 0.42, 14, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0xf2f2f2, wireframe: true, transparent: true, opacity: 0.7,
      })
    );
    net.position.set(0, RIM_Y - 0.21, RIM_Z);
    scene.add(net);

    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.1, RIM_Y + 0.9, 12),
      new THREE.MeshStandardMaterial({ color: 0x3a4152, roughness: 0.5 })
    );
    pole.position.set(0, (RIM_Y + 0.9) / 2, RIM_Z - 1.1);
    pole.castShadow = true;
    scene.add(pole);

    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 20, 16),
      new THREE.MeshStandardMaterial({ color: 0xd9642a, roughness: 0.85 })
    );
    this.ball.castShadow = true;
    scene.add(this.ball);
    this.ballShadow = blobShadow(0.4);
    scene.add(this.ballShadow);

    // where the shot will go, so aiming is readable
    this.guide = new THREE.Mesh(
      new THREE.PlaneGeometry(0.06, 7),
      new THREE.MeshBasicMaterial({
        color: 0x7fe3ff, transparent: true, opacity: 0.3, depthWrite: false,
      })
    );
    this.guide.rotation.x = -Math.PI / 2;
    scene.add(this.guide);
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    this.players = [];
    const n = Math.min(2, this.ctx.humanCount());
    for (let i = 0; i < n; i++) {
      this.players.push({ seat: i, score: 0, made: 0, taken: 0, streak: 0, best: 0 });
    }
    this.active = 0;
    this.spot = 0;
    this.timeLeft = ROUND_TIME;
    this.over = false;
    this.flight = null;
    this.resetAt = 0;
    this.aimYaw = 0;
    this._place();
    this._brief();
    this._syncHud();
    this.ctx.ui.toast("BASKETBALL",
      this.players.length > 1 ? "Take it in turns" : "As many as you can in 75 seconds", 2000);
  }

  exit() { }

  _brief() {
    for (let i = 0; i < this.players.length; i++) {
      const c = this.ctx.seat(i);
      if (!c) { continue; }
      this.ctx.net.mode(c.pid,
        this.players.length > 1 ? "Basketball - P" + (i + 1) : "Basketball",
        "Tilt to aim, then swing the phone up and forward to shoot.",
        "SHOOT", "Swing to take the shot");
    }
  }

  _place() {
    const s = SPOTS[this.spot % SPOTS.length];
    this.shotFrom = new THREE.Vector3(s.x, 1.75, RIM_Z + 4.2 + s.z);
    this.spotName = s.name;
    this.flight = null;
    this.ball.position.copy(this.shotFrom);
    this.camera.position.set(s.x * 0.6, 2.5, this.shotFrom.z + 2.6);
    this.camera.lookAt(0, RIM_Y - 0.2, RIM_Z);
  }

  // ------------------------------------------------------------ shooting

  onSwing(swing) {
    if (this.over || this.flight) { return; }
    const seat = this.ctx.seatOf(swing.pid);
    if (seat < 0 || seat >= this.players.length) { return; }
    if (seat !== this.active) { return; }
    if (swing.power < 0.12) { return; }

    const p = this.players[this.active];
    p.taken++;

    // distance to the hoop decides how much power a clean shot needs
    const dx = -this.shotFrom.x, dz = RIM_Z - this.shotFrom.z;
    const flat = Math.hypot(dx, dz);
    const rise = RIM_Y - this.shotFrom.y;

    // a 52 degree launch, nudged by how much the phone was pitched
    const angle = clamp(52 + swing.lean * 14, 34, 68) * Math.PI / 180;
    // the speed that would drop the ball exactly through the ring
    const cos = Math.cos(angle), tan = Math.tan(angle);
    const denom = 2 * cos * cos * (flat * tan - rise);
    const ideal = denom > 0 ? Math.sqrt(G * flat * flat / denom) : 9;

    // your swing scales that: a middling swing is the money shot, too soft
    // falls short and too hard clangs long off the back of the rim
    const power = 0.85 + swing.power * 0.30;
    const speed = ideal * power;

    const yaw = Math.atan2(dx, dz) + this.aimYaw;
    this.flight = {
      pos: this.shotFrom.clone(),
      vel: new THREE.Vector3(
        Math.sin(yaw) * Math.cos(angle) * speed,
        Math.sin(angle) * speed,
        Math.cos(yaw) * Math.cos(angle) * speed),
      scored: false, crossed: false, touched: false, t: 0,
    };
    sfx.whoosh();
    this.ctx.net.buzz(swing.pid, 25);
  }

  _step(dt) {
    const f = this.flight;
    if (!f) { return; }
    f.t += dt;
    const prevY = f.pos.y;

    // No air drag: over four metres it is negligible, and leaving it out keeps
    // the launch-speed solve below exact. With drag in the flight but not in
    // the formula, a perfectly judged swing always fell short.
    f.vel.y -= G * dt;
    f.pos.addScaledVector(f.vel, dt);

    // backboard
    if (f.pos.z < this.boardZ && f.vel.z < 0
        && Math.abs(f.pos.x) < 0.95 && f.pos.y > RIM_Y - 0.05 && f.pos.y < RIM_Y + 1.05) {
      f.pos.z = this.boardZ;
      f.vel.z *= -0.55;
      f.vel.x *= 0.85;
      f.touched = true;
      sfx.noise(0.1, 700, { gain: 0.16, q: 1.2 });
    }

    /*
     * The rim is a ring, so the ball only touches it when its centre comes
     * within a ball-radius of that *circle* - measured in both the radial and
     * the vertical direction at once.
     *
     * Testing the two separately (near the ring's height AND near its radius)
     * looks equivalent but is not: a clean shot dropping through the middle
     * passes the near edge while still well above the ring, and the loose test
     * batted it away. Nothing could be scored cleanly.
     */
    const dxr = f.pos.x, dzr = f.pos.z - RIM_Z;
    const radial = Math.hypot(dxr, dzr);
    const toRing = Math.hypot(radial - RIM_R, f.pos.y - RIM_Y);
    if (toRing < BALL_R + 0.018) {
      const nx = dxr / (radial || 1), nz = dzr / (radial || 1);
      const outward = radial > RIM_R ? 1 : -1;
      f.vel.x += nx * outward * 1.1;
      f.vel.z += nz * outward * 1.1;
      f.vel.y *= 0.62;
      f.touched = true;
      sfx.noise(0.09, 1800, { gain: 0.14, q: 2 });
    }

    // through the ring, downward, inside the radius
    if (!f.crossed && prevY > RIM_Y && f.pos.y <= RIM_Y && f.vel.y < 0) {
      f.crossed = true;
      if (radial < RIM_R - BALL_R * 0.35) { this._score(!f.touched); }
    }

    if (f.pos.y <= BALL_R) {
      f.pos.y = BALL_R;
      f.vel.y = -f.vel.y * 0.55;
      f.vel.x *= 0.7; f.vel.z *= 0.7;
      if (Math.abs(f.vel.y) < 1.2) { this._endShot(); }
      else { sfx.bounce(0.4); }
    }
    if (f.t > 7) { this._endShot(); }
  }

  _score(swish) {
    const p = this.players[this.active];
    const three = Math.hypot(this.shotFrom.x, this.shotFrom.z - RIM_Z) > 6.6;
    let points = three ? 3 : 2;
    p.streak++;
    p.best = Math.max(p.best, p.streak);
    if (p.streak >= 3) { points += 1; }
    if (swish) { points += 1; }
    p.score += points;
    p.made++;
    this.flight.scored = true;

    const who = this.players.length > 1 ? "P" + (this.active + 1) + " " : "";
    this.ctx.ui.toast(
      who + (swish ? "SWISH!" : three ? "THREE!" : "SCORE"),
      "+" + points + (p.streak >= 3 ? "   " + p.streak + " in a row" : ""), 1300);
    sfx.point(true);
    if (p.streak >= 3) { sfx.cheer(0.5); }
    this.ctx.net.buzz(this._pid(), 120);
    this._syncHud();
  }

  _endShot() {
    if (!this.flight) { return; }
    const p = this.players[this.active];
    if (!this.flight.scored) {
      p.streak = 0;
      sfx.point(false);
    }
    this.flight = null;
    this.resetAt = performance.now() + 700;
  }

  _pid() {
    const c = this.ctx.seat(this.active);
    return c ? c.pid : 0;
  }

  // ------------------------------------------------------------ update

  update(dt, time) {
    if (!this.over) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) { this._finish(); }
    }

    const c = this.ctx.seat(this.active);
    if (c && !this.flight && !this.over) {
      this.aimYaw = damp(this.aimYaw, clamp(c.aim, -1, 1) * 0.22, 8, dt);
    }

    if (this.flight) {
      // _step can finish the shot and drop the flight, so re-check before use
      this._step(dt);
      if (this.flight) {
        this.ball.position.copy(this.flight.pos);
        this.ball.rotation.x -= dt * 6;
      }
    } else if (this.resetAt && performance.now() > this.resetAt) {
      this.resetAt = 0;
      this.spot++;
      if (this.players.length > 1) { this.active = 1 - this.active; }
      this._place();
      this._syncHud();
    } else {
      this.ball.position.copy(this.shotFrom);
      this.ball.position.y += Math.sin(time * 3) * 0.04;
    }

    this.ballShadow.position.set(this.ball.position.x, 0.02, this.ball.position.z);
    const h = clamp(this.ball.position.y, 0, 8);
    this.ballShadow.scale.setScalar(clamp(1 - h / 10, 0.3, 1));

    const aiming = !this.flight && !this.over;
    this.guide.visible = aiming;
    if (aiming) {
      const yaw = Math.atan2(-this.shotFrom.x, RIM_Z - this.shotFrom.z) + this.aimYaw;
      this.guide.position.set(
        this.shotFrom.x + Math.sin(yaw) * 3.5, 0.03,
        this.shotFrom.z + Math.cos(yaw) * 3.5);
      this.guide.rotation.z = -yaw;
    }

    this.ctx.ui.prompt(this.over ? ""
      : this.players.length > 1
        ? "Player " + (this.active + 1) + " - " + this.spotName
        : "Swing to shoot from the " + this.spotName);
    this._syncHud();
  }

  _finish() {
    this.over = true;
    const ranked = [...this.players].sort((a, b) => b.score - a.score);
    const top = ranked[0];
    if (this.players.length > 1) {
      this.ctx.ui.toast(
        ranked[0].score === ranked[1].score ? "DRAW"
          : "PLAYER " + (top.seat + 1) + " WINS",
        top.score + " points", 9000);
    } else {
      this.ctx.ui.toast("TIME", top.score + " points  ·  "
        + top.made + "/" + top.taken + " made", 9000);
    }
    sfx.cheer(1);
  }

  _syncHud() {
    const cards = this.players.map((p, i) =>
      '<div class="shotCard' + (i === this.active && !this.over ? " on" : "") + '">'
      + (this.players.length > 1 ? '<span class="tag ' + (i ? "red" : "blue")
         + '">P' + (i + 1) + "</span>" : "")
      + '<span class="big">' + p.score + '</span>'
      + '<span class="sub">' + p.made + "/" + p.taken
      + (p.best > 1 ? "  ·  best run " + p.best : "") + '</span></div>').join("");
    this.ctx.ui.hud('<div class="shotHud">' + cards + '</div>'
      + '<div class="hudSub">' + Math.max(0, Math.ceil(this.timeLeft)) + 's left</div>');
  }
}
