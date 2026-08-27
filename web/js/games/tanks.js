/*
 * Tank duel - turn-based artillery.
 *
 * Tilt to set the barrel angle, then hold the button to wind the shot up and
 * let go to fire. The power bar climbs while you hold, so a light tap lobs it
 * short and a long hold sends it over.
 *
 * The ground is a heightfield of columns. Shells knock craters in it, and the
 * tanks settle onto whatever is left underneath them.
 */

import * as THREE from "../../lib/three.module.js";
import { addLights, skyDome, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";

const G = 9.81;
const COLS = 120;             // terrain columns
const WORLD_W = 60;           // metres across
const COL_W = WORLD_W / COLS;
const WIND_MAX = 4;
const MAX_POWER = 26;
const CHARGE_RATE = 22;       // power per second while holding

export class TanksGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Tank Duel";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.1, 400);
    this.cameras = [this.camera];
    this.columns = [];
    this._build();
  }

  _build() {
    const scene = this.scene;
    scene.add(skyDome(0x2a3a6b, 0xd9a06b));
    scene.fog = new THREE.Fog(0xb08b6b, 60, 200);
    addLights(scene, { sky: 0xd8e0f5, ground: 0x6b5230, ambient: 0.95, sun: 1.2,
                       shadowRange: 30 });

    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(300, 90),
      new THREE.MeshStandardMaterial({ color: 0x5a6a8a, roughness: 1 })
    );
    back.position.set(0, 30, -25);
    scene.add(back);

    // terrain columns, one box each
    const geo = new THREE.BoxGeometry(COL_W * 1.02, 1, 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0x7a6034, roughness: 0.96 });
    this.terrain = new THREE.InstancedMesh(geo, mat, COLS);
    this.terrain.castShadow = true;
    this.terrain.receiveShadow = true;
    scene.add(this.terrain);
    this._dummy = new THREE.Object3D();

    this.tanks = [];
    for (let i = 0; i < 2; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(1.9, 0.6, 1.4),
        new THREE.MeshStandardMaterial({
          color: i === 0 ? 0x3f7fe8 : 0xd0402f, roughness: 0.55,
        })
      );
      body.position.y = 0.45;
      body.castShadow = true;
      g.add(body);
      const turret = new THREE.Mesh(
        new THREE.SphereGeometry(0.45, 14, 10),
        new THREE.MeshStandardMaterial({
          color: i === 0 ? 0x2f6fe0 : 0xb0301f, roughness: 0.5,
        })
      );
      turret.position.y = 0.85;
      turret.castShadow = true;
      g.add(turret);

      const pivot = new THREE.Group();
      pivot.position.y = 0.85;
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.11, 1.5, 10),
        new THREE.MeshStandardMaterial({ color: 0x39404f, roughness: 0.4, metalness: 0.5 })
      );
      barrel.rotation.z = -Math.PI / 2;
      barrel.position.x = 0.75;
      pivot.add(barrel);
      g.add(pivot);

      for (const sx of [-0.65, 0, 0.65]) {
        const wheel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.24, 0.24, 1.5, 10),
          new THREE.MeshStandardMaterial({ color: 0x22252e, roughness: 0.85 })
        );
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(sx, 0.24, 0);
        g.add(wheel);
      }
      g.userData.pivot = pivot;
      scene.add(g);
      this.tanks.push({ mesh: g, pivot });
    }

    this.shell = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.4 })
    );
    this.shell.visible = false;
    scene.add(this.shell);

    this.camera.position.set(0, 14, 34);
    this.camera.lookAt(0, 6, 0);
  }

  _terrainHeight(x) {
    const i = clamp(Math.round((x + WORLD_W / 2) / COL_W), 0, COLS - 1);
    return this.height[i];
  }

  _generate() {
    this.height = new Float32Array(COLS);
    const seedA = Math.random() * 6.3, seedB = Math.random() * 6.3;
    for (let i = 0; i < COLS; i++) {
      const t = i / COLS;
      this.height[i] = 6
        + Math.sin(t * 6.3 + seedA) * 2.6
        + Math.sin(t * 13.5 + seedB) * 1.3
        + Math.sin(t * 3.1 + seedA * 2) * 1.8;
    }
    this._refreshTerrain();
  }

  _refreshTerrain() {
    for (let i = 0; i < COLS; i++) {
      const h = Math.max(0.4, this.height[i]);
      const x = -WORLD_W / 2 + (i + 0.5) * COL_W;
      this._dummy.position.set(x, h / 2, 0);
      this._dummy.scale.set(1, h, 1);
      this._dummy.updateMatrix();
      this.terrain.setMatrixAt(i, this._dummy.matrix);
    }
    this.terrain.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    this.twoPlayer = this.ctx.humanCount() >= 2;
    this._generate();

    this.state = [
      { x: -WORLD_W / 2 + 6, hp: 100, angle: 40, charging: false, power: 0 },
      { x: WORLD_W / 2 - 6, hp: 100, angle: 140, charging: false, power: 0 },
    ];
    for (const t of this.state) { t.y = this._terrainHeight(t.x); }

    this.active = 0;
    this.over = false;
    this.flight = null;
    this.wind = (Math.random() - 0.5) * 2 * WIND_MAX;
    this.aiFireAt = 0;
    this.nextAt = 0;
    this.restartAt = 0;
    this._brief();
    this._syncHud();
    this.ctx.ui.toast("TANK DUEL",
      this.twoPlayer ? "Player 1 fires first" : "Beat the computer gunner", 2000);
  }

  exit() { }

  _brief() {
    for (let i = 0; i < (this.twoPlayer ? 2 : 1); i++) {
      const c = this.ctx.seat(i);
      if (!c) { continue; }
      this.ctx.net.mode(c.pid,
        this.twoPlayer ? "Tank Duel - P" + (i + 1) : "Tank Duel",
        "Tilt to set the angle. Hold the button to build power, release to fire.",
        "HOLD", "Hold to charge, let go to fire");
    }
  }

  _isHuman(i) { return i === 0 || this.twoPlayer; }

  // ------------------------------------------------------------ input

  onButton(down, pid) {
    if (this.over || this.flight) { return; }
    const seat = this.ctx.seatOf(pid);
    if (seat !== this.active || seat < 0) { return; }
    if (!this._isHuman(this.active)) { return; }
    const t = this.state[this.active];
    if (down) {
      t.charging = true;
      t.power = 0;
    } else if (t.charging) {
      t.charging = false;
      this._fire(this.active, t.angle, Math.max(4, t.power));
    }
  }

  onSwing() { }

  _fire(who, angleDeg, power) {
    const t = this.state[who];
    const a = angleDeg * Math.PI / 180;
    this.flight = {
      x: t.x + Math.cos(a) * 1.5,
      y: t.y + 0.85 + Math.sin(a) * 1.5,
      vx: Math.cos(a) * power,
      vy: Math.sin(a) * power,
      from: who, t: 0,
    };
    this.shell.visible = true;
    sfx.crashInto(0.5);
    this.ctx.net.buzz(0, 40);
  }

  _stepShell(dt) {
    const f = this.flight;
    const steps = 4;
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      f.vx += this.wind * 0.12 * h;
      f.vy -= G * h;
      f.x += f.vx * h;
      f.y += f.vy * h;
      f.t += h;

      if (Math.abs(f.x) > WORLD_W / 2 + 6 || f.y < -12 || f.t > 22) {
        this._explode(f.x, f.y, false);
        return;
      }
      // a hit on either tank
      for (let i = 0; i < 2; i++) {
        const t = this.state[i];
        if (Math.abs(f.x - t.x) < 1.2 && Math.abs(f.y - (t.y + 0.6)) < 1.0) {
          this._explode(f.x, f.y, true, i);
          return;
        }
      }
      if (f.y <= this._terrainHeight(f.x)) {
        this._explode(f.x, this._terrainHeight(f.x), false);
        return;
      }
    }
  }

  _explode(x, y, direct, hitIdx) {
    this.flight = null;
    this.shell.visible = false;
    sfx.crash(0.9);

    // dig a crater
    const radius = 3.2;
    for (let i = 0; i < COLS; i++) {
      const cx = -WORLD_W / 2 + (i + 0.5) * COL_W;
      const d = Math.abs(cx - x);
      if (d < radius) {
        const dig = Math.sqrt(radius * radius - d * d) * 0.8;
        this.height[i] = Math.max(0.4, this.height[i] - dig);
      }
    }
    this._refreshTerrain();

    // splash damage on both tanks
    let killed = -1;
    for (let i = 0; i < 2; i++) {
      const t = this.state[i];
      t.y = this._terrainHeight(t.x);
      const d = Math.hypot(t.x - x, t.y + 0.5 - y);
      let dmg = 0;
      if (direct && hitIdx === i) { dmg = 46; }
      else if (d < radius + 1) { dmg = Math.round(34 * (1 - d / (radius + 1))); }
      if (dmg > 0) {
        t.hp = Math.max(0, t.hp - dmg);
        this.ctx.net.buzz(0, 80 + dmg * 2);
        if (i !== this.active) {
          this.ctx.ui.toast(direct ? "DIRECT HIT" : "HIT", "-" + dmg, 1400);
        } else if (dmg > 0) {
          this.ctx.ui.toast("OWN GOAL", "-" + dmg, 1400);
        }
        if (t.hp === 0) { killed = i; }
      }
    }

    if (killed >= 0) {
      this.over = true;
      const winner = 1 - killed;
      const title = this.twoPlayer ? "PLAYER " + (winner + 1) + " WINS"
        : (winner === 0 ? "YOU WIN!" : "YOU WERE DESTROYED");
      this.ctx.ui.toast(title, "", 9000);
      sfx.cheer(winner === 0 ? 1 : 0.3);
      this.restartAt = performance.now() + 9000;
      this._syncHud();
      return;
    }

    this.nextAt = performance.now() + 900;
    this._syncHud();
  }

  /** The computer gunner: aim well, then miss by a little on purpose. */
  _aiShot() {
    const me = this.state[1], foe = this.state[0];
    const dx = foe.x - me.x;
    const dy = (foe.y + 0.6) - (me.y + 0.85);
    let best = null;
    for (let deg = 100; deg <= 175; deg += 1.5) {
      const a = deg * Math.PI / 180;
      const cos = Math.cos(a), sin = Math.sin(a);
      // solve for the speed that lands on the target at this angle
      const denom = 2 * cos * cos * (dx * (sin / cos) - dy);
      if (denom <= 0) { continue; }
      const v = Math.sqrt(G * dx * dx / denom);
      if (!isFinite(v) || v > MAX_POWER) { continue; }
      if (!best || v < best.v) { best = { deg, v }; }
    }
    if (!best) { best = { deg: 140, v: 18 }; }
    // scatter, tightening as the duel goes on
    const slop = me.hp > 60 ? 5 : 2.5;
    me.angle = best.deg + (Math.random() - 0.5) * slop;
    this._fire(1, me.angle, clamp(best.v * (1 + (Math.random() - 0.5) * 0.09), 4, MAX_POWER));
  }

  // ------------------------------------------------------------ update

  update(dt, time) {
    const t = this.state[this.active];

    if (!this.over && !this.flight && this._isHuman(this.active)) {
      const c = this.ctx.seat(this.active);
      if (c) {
        // barrel angle: player one points right, player two points left
        const base = this.active === 0 ? 0 : 180;
        const dir = this.active === 0 ? 1 : -1;
        t.angle = clamp(base + dir * (45 - c.lean * 45), this.active === 0 ? 5 : 95,
          this.active === 0 ? 85 : 175);
      }
      if (t.charging) {
        t.power = Math.min(MAX_POWER, t.power + CHARGE_RATE * dt);
      }
    }

    if (!this.over && !this.flight && !this._isHuman(this.active)
        && !this.nextAt && !this.aiFireAt) {
      this.aiFireAt = performance.now() + 900;
    }
    if (this.aiFireAt && performance.now() > this.aiFireAt) {
      this.aiFireAt = 0;
      this._aiShot();
    }

    if (this.flight) {
      this._stepShell(dt);
      if (this.flight) { this.shell.position.set(this.flight.x, this.flight.y, 0); }
    }

    if (this.nextAt && performance.now() > this.nextAt) {
      this.nextAt = 0;
      this.active = 1 - this.active;
      this.wind = (Math.random() - 0.5) * 2 * WIND_MAX;
      this.state[this.active].power = 0;
      this._syncHud();
    }

    if (this.over && this.restartAt && performance.now() > this.restartAt) {
      this.restartAt = 0;
      this.enter();
      return;
    }

    // place the tanks on whatever ground is left
    for (let i = 0; i < 2; i++) {
      const s = this.state[i];
      s.y = this._terrainHeight(s.x);
      const tank = this.tanks[i];
      tank.mesh.position.set(s.x, s.y, 0);
      tank.mesh.visible = s.hp > 0;
      const a = s.angle * Math.PI / 180;
      tank.pivot.rotation.z = a;
    }

    // follow the shell, otherwise frame both tanks
    const focusX = this.flight ? this.flight.x : (this.state[0].x + this.state[1].x) / 2;
    const focusY = this.flight ? Math.max(6, this.flight.y) : 8;
    this.camera.position.x = damp(this.camera.position.x, focusX * 0.5, 2.5, dt);
    this.camera.position.y = damp(this.camera.position.y, focusY + 6, 2.5, dt);
    this.camera.position.z = damp(this.camera.position.z, 36, 2, dt);
    this.camera.lookAt(focusX * 0.5, focusY - 1, 0);

    this.ctx.ui.prompt(this.over ? ""
      : this.flight ? ""
        : !this._isHuman(this.active) ? "Enemy gunner is ranging…"
          : t.charging ? "Let go to fire!"
            : "Tilt for angle, hold the button to charge");
    this._syncHud();
  }

  _syncHud() {
    const bar = (v, max, cls) =>
      '<div class="bar"><i class="' + cls + '" style="width:'
      + clamp(v / max * 100, 0, 100).toFixed(0) + '%"></i></div>';
    const p1 = this.twoPlayer ? "P1" : "YOU";
    const p2 = this.twoPlayer ? "P2" : "CPU";
    const t = this.state[this.active];
    const windDir = this.wind > 0.2 ? "→" : this.wind < -0.2 ? "←" : "·";
    this.ctx.ui.hud(
      '<div class="hudRow boxRow">'
      + '<span class="tag blue">' + p1 + '</span>' + bar(this.state[0].hp, 100, "blue")
      + '<span class="round">' + windDir + " " + Math.abs(this.wind).toFixed(1) + '</span>'
      + bar(this.state[1].hp, 100, "red") + '<span class="tag red">' + p2 + '</span>'
      + '</div>'
      + '<div class="hudSub">'
      + (this.over ? "battle over"
        : "angle " + Math.round(this.active === 0 ? t.angle : 180 - t.angle) + "°"
          + (t.charging ? "   ·   power " + Math.round(t.power / MAX_POWER * 100) + "%" : ""))
      + '</div>');
  }
}
