/*
 * Duck shooting.
 *
 * Point the phone like a gun and press to fire. Everyone shoots at the same
 * flock on one shared screen - no split view - so each player gets their own
 * coloured scope reticle drawn over the scene, and their own shells and score.
 *
 * Aiming mixes two sources on purpose. Up and down comes from the phone's
 * pitch measured against gravity, which is absolute and never drifts. Left and
 * right integrates the rotation rate about the vertical axis, because there is
 * no trustworthy absolute compass heading indoors - it can creep over time, so
 * "Re-centre" on the phone resets it.
 */

import * as THREE from "../../lib/three.module.js";
import { addLights, skyDome, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";

const SHELLS = 3;              // shots per player per wave
const WAVES = 10;
const WAVE_TIME = 13;          // seconds before the ducks get away
const DUCK_HIT_R = 1.5;        // generous, because pointing a phone is coarse
const AIM_DIST = 46;           // where the reticle sits along the aim ray

const YAW_LIMIT = 55;          // degrees either side of centre
const PITCH_LIMIT = 30;
const MAX_PLAYERS = 4;

const PLAYER_COLORS = ["#7fe3ff", "#ffd166", "#a0f0a0", "#ff9ecb"];

export class DuckGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Duck Shooting";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 700);
    this.cameras = [this.camera];
    this.ducks = [];
    this.scopes = [];
    this._build();
  }

  // ------------------------------------------------------------ scenery

  _build() {
    const scene = this.scene;
    scene.add(skyDome(0x2c5fa8, 0xf3c98a));       // dusk, so ducks read well
    scene.fog = new THREE.Fog(0xcbd8e6, 90, 420);
    addLights(scene, { sky: 0xbcd4f2, ground: 0x4a5a32, ambient: 0.9, sun: 1.2,
                       shadowRange: 40 });

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(700, 700),
      new THREE.MeshStandardMaterial({ color: 0x50702f, roughness: 0.98 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const pond = new THREE.Mesh(
      new THREE.CircleGeometry(34, 40),
      new THREE.MeshStandardMaterial({
        color: 0x2f5f86, roughness: 0.15, metalness: 0.5,
      })
    );
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(0, 0.05, -46);
    scene.add(pond);

    this._reeds();
    this._trees();

    this.camera.position.set(0, 2.1, 16);
    this.camera.lookAt(0, 9, -40);
  }

  _reeds() {
    const geo = new THREE.ConeGeometry(0.22, 3.2, 4);
    const mesh = new THREE.InstancedMesh(geo,
      new THREE.MeshStandardMaterial({ color: 0x6b7f35, roughness: 0.95 }), 400);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 400; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 30 + Math.random() * 12;
      dummy.position.set(Math.cos(a) * r, 1.4, -46 + Math.sin(a) * r);
      dummy.rotation.set((Math.random() - 0.5) * 0.3, Math.random() * 3, 0);
      dummy.scale.setScalar(0.7 + Math.random() * 0.7);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }

  _trees() {
    const trunk = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.5, 0.7, 5, 6),
      new THREE.MeshStandardMaterial({ color: 0x4b3524, roughness: 0.95 }), 90);
    const leaves = new THREE.InstancedMesh(
      new THREE.SphereGeometry(4.2, 10, 8),
      new THREE.MeshStandardMaterial({ roughness: 0.92 }), 90);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 70 + Math.random() * 140;
      const x = Math.cos(a) * r;
      const z = -46 + Math.sin(a) * r;
      const scale = 0.8 + Math.random() * 0.9;
      dummy.position.set(x, 2.5 * scale, z);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      trunk.setMatrixAt(i, dummy.matrix);
      dummy.position.y = 6.6 * scale;
      dummy.updateMatrix();
      leaves.setMatrixAt(i, dummy.matrix);
      color.setHSL(0.26 + Math.random() * 0.08, 0.4, 0.2 + Math.random() * 0.12);
      leaves.setColorAt(i, color);
    }
    trunk.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    this.scene.add(trunk, leaves);
  }

  // ------------------------------------------------------------ ducks

  _makeDuck() {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a4032, roughness: 0.8 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0x1f6b3a, roughness: 0.6 });
    const beakMat = new THREE.MeshStandardMaterial({ color: 0xe8a33d, roughness: 0.5 });

    const body = new THREE.Mesh(new THREE.SphereGeometry(0.8, 14, 11), bodyMat);
    body.scale.set(1.5, 0.85, 0.85);
    body.castShadow = true;
    g.add(body);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.44, 12, 10), headMat);
    head.position.set(1.15, 0.42, 0);
    g.add(head);

    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.6, 8), beakMat);
    beak.rotation.z = -Math.PI / 2;
    beak.position.set(1.62, 0.36, 0);
    g.add(beak);

    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.8, 6), bodyMat);
    tail.rotation.z = Math.PI / 2;
    tail.position.set(-1.35, 0.12, 0);
    g.add(tail);

    const wingGeo = new THREE.BoxGeometry(1.0, 0.1, 1.5);
    const wings = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(0, 0.3, side * 0.5);
      const wing = new THREE.Mesh(wingGeo, bodyMat);
      wing.position.set(0, 0, side * 0.75);
      wing.castShadow = true;
      pivot.add(wing);
      g.add(pivot);
      wings.push({ pivot, side });
    }
    g.userData.wings = wings;
    return g;
  }

  _spawnWave() {
    for (const d of this.ducks) { this.scene.remove(d.mesh); }
    this.ducks = [];

    const count = Math.min(4, 2 + Math.floor(this.wave / 3));
    for (let i = 0; i < count; i++) {
      const mesh = this._makeDuck();
      this.scene.add(mesh);
      const fromLeft = Math.random() < 0.5;
      const speed = 9 + this.wave * 0.9 + Math.random() * 4;
      const duck = {
        mesh,
        pos: new THREE.Vector3(
          fromLeft ? -55 - Math.random() * 15 : 55 + Math.random() * 15,
          9 + Math.random() * 7,
          -26 - Math.random() * 30),
        vel: new THREE.Vector3((fromLeft ? 1 : -1) * speed, 0, 0),
        alive: true,
        falling: false,
        bobPhase: Math.random() * 6.3,
        bobRate: 1.4 + Math.random(),
        flap: Math.random() * 6.3,
        gone: false,
      };
      this.ducks.push(duck);
    }

    for (const p of this.players) { p.shells = SHELLS; p.waveHits = 0; }
    this.waveTime = WAVE_TIME;
    this.waveActive = true;
    sfx.quack();
    this.ctx.ui.toast("WAVE " + this.wave, count + (count === 1 ? " duck" : " ducks"), 1400);
    this._syncHud();
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    const n = clamp(this.ctx.humanCount(), 1, MAX_PLAYERS);
    this.players = [];
    for (let i = 0; i < n; i++) {
      this.players.push({
        seat: i,
        yaw: 0, pitch: 0,
        recoil: 0,
        shells: SHELLS,
        score: 0,
        hits: 0,
        shotsFired: 0,
        wasDown: false,
        aimPoint: new THREE.Vector3(),
      });
    }

    this.wave = 1;
    this.over = false;
    this.betweenWaves = 0;
    this._buildScopes();
    this._brief();
    this._spawnWave();
    sfx.resume();
    this.ctx.ui.toast("DUCK SHOOTING",
      n > 1 ? n + " players - fastest trigger wins" : "Point and press to fire", 1800);
  }

  exit() {
    this._clearScopes();
  }

  _brief() {
    for (let i = 0; i < this.players.length; i++) {
      const c = this.ctx.seat(i);
      if (!c) { continue; }
      this.ctx.net.mode(c.pid,
        this.players.length > 1 ? "Ducks - Player " + (i + 1) : "Duck Shooting",
        "Point the phone like a gun. Press to fire. Re-centre if your aim drifts.",
        "FIRE", "Press to shoot");
    }
  }

  // -------------------------------------------------- the on-screen scopes

  _buildScopes() {
    this._clearScopes();
    const host = document.getElementById("scopes");
    if (!host) { return; }
    for (let i = 0; i < this.players.length; i++) {
      const el = document.createElement("div");
      el.className = "scope";
      el.style.setProperty("--c", PLAYER_COLORS[i % PLAYER_COLORS.length]);
      el.innerHTML =
        '<div class="ring"></div>'
        + '<div class="cross v"></div><div class="cross h"></div>'
        + '<div class="dot"></div>'
        + (this.players.length > 1 ? '<div class="who">P' + (i + 1) + "</div>" : "");
      host.appendChild(el);
      this.scopes.push(el);
    }
  }

  _clearScopes() {
    for (const el of this.scopes) {
      if (el.parentNode) { el.parentNode.removeChild(el); }
    }
    this.scopes = [];
  }

  // ------------------------------------------------------------ input

  onButton(down, pid) {
    const seat = this.ctx.seatOf(pid);
    if (seat < 0 || seat >= this.players.length) { return; }
    if (down) { this._fire(this.players[seat]); }
  }

  onSwing() { /* aiming is continuous; the trigger is the button */ }

  /**
   * Re-centre: wherever the player is pointing becomes straight ahead.
   *
   * The left/right aim here is integrated from the turn rate, so it is not
   * covered by the controller's own reference angles and has to be zeroed
   * separately - otherwise pressing re-centre moved the crosshair vertically
   * but left it stuck off to one side.
   */
  onCalibrate(pid) {
    const seat = this.ctx.seatOf(pid);
    if (seat < 0 || seat >= this.players.length) { return; }
    const p = this.players[seat];
    p.yaw = 0;
    p.pitch = 0;
    p.recoil = 0;
    this.ctx.net.buzz(pid, 25);
    this.ctx.ui.toast(this.players.length > 1 ? "P" + (seat + 1) + " RE-CENTRED"
      : "RE-CENTRED", "you are now aiming straight ahead", 1100);
  }

  _fire(p) {
    if (this.over) { return; }
    const c = this.ctx.seat(p.seat);
    const pid = c ? c.pid : 0;

    if (p.shells <= 0) {
      sfx.emptyClick();
      this.ctx.net.buzz(pid, 12, false);
      return;
    }
    p.shells--;
    p.shotsFired++;
    sfx.shot();
    this.ctx.net.buzz(pid, 45);

    // Work out where the shot went BEFORE kicking the barrel up. Applying the
    // recoil first threw every shot about four degrees high, which at typical
    // duck range is several metres - nothing could ever be hit.
    const origin = this.camera.position;
    const dir = this._aimDir(p);
    p.recoil = 1;

    // nearest duck whose centre falls inside the shot cone
    let best = null;
    let bestDist = Infinity;
    for (const duck of this.ducks) {
      if (!duck.alive) { continue; }
      const vx = duck.pos.x - origin.x;
      const vy = duck.pos.y - origin.y;
      const vz = duck.pos.z - origin.z;
      const along = vx * dir.x + vy * dir.y + vz * dir.z;
      if (along <= 0) { continue; }
      const px = vx - dir.x * along;
      const py = vy - dir.y * along;
      const pz = vz - dir.z * along;
      const perp = Math.hypot(px, py, pz);
      // the cone widens slightly with range so distant ducks stay fair
      if (perp > DUCK_HIT_R * (1 + along / 90)) { continue; }
      if (along < bestDist) { bestDist = along; best = duck; }
    }

    if (best) {
      best.alive = false;
      best.falling = true;
      best.vel.set(best.vel.x * 0.25, 0, 0);
      p.hits++;
      p.waveHits = (p.waveHits || 0) + 1;
      const points = 100 + Math.round(bestDist);
      p.score += points;
      sfx.feathers();
      this.ctx.net.buzz(pid, 110);
      this.ctx.ui.toast(this.players.length > 1 ? "P" + (p.seat + 1) + " HIT!" : "HIT!",
        "+" + points, 900);
    }
    this._syncHud();
  }

  /** Unit vector the player is pointing along, in world space. */
  _aimDir(p) {
    const yaw = (p.yaw + (p.recoilYaw || 0)) * Math.PI / 180;
    const pitch = (p.pitch + p.recoil * 4) * Math.PI / 180;
    const cp = Math.cos(pitch);
    return new THREE.Vector3(
      Math.sin(yaw) * cp,
      Math.sin(pitch),
      -Math.cos(yaw) * cp
    ).normalize();
  }

  // ------------------------------------------------------------ update

  update(dt, time) {
    for (const p of this.players) { this._aim(p, dt); }
    this._flyDucks(dt, time);

    if (!this.over) {
      if (this.betweenWaves > 0) {
        this.betweenWaves -= dt;
        if (this.betweenWaves <= 0) {
          this.wave++;
          if (this.wave > WAVES) { this._finish(); }
          else { sfx.reload(); this._spawnWave(); }
        }
      } else if (this.waveActive) {
        this.waveTime -= dt;
        const allDone = this.ducks.every(d => !d.alive || d.gone);
        const outOfShells = this.players.every(p => p.shells <= 0);
        if (allDone || this.waveTime <= 0 || (outOfShells && this._noneFalling())) {
          this._endWave();
        }
      }
    }

    this._drawScopes();
    this._syncHud();
  }

  _noneFalling() {
    return this.ducks.every(d => !d.falling);
  }

  _aim(p, dt) {
    const c = this.ctx.seat(p.seat);
    if (!c) { return; }
    // yaw integrates the turn rate; pitch is absolute from gravity
    p.yaw = clamp(p.yaw + c.yaw * dt * 0.55, -YAW_LIMIT, YAW_LIMIT);
    p.pitch = clamp(-c.lean * PITCH_LIMIT, -PITCH_LIMIT, PITCH_LIMIT);
    p.recoil = Math.max(0, p.recoil - dt * 4.5);

    const dir = this._aimDir(p);
    p.aimPoint.copy(this.camera.position).addScaledVector(dir, AIM_DIST);
  }

  _flyDucks(dt, time) {
    for (const duck of this.ducks) {
      if (duck.gone) { continue; }

      if (duck.falling) {
        duck.vel.y -= 22 * dt;
        duck.pos.addScaledVector(duck.vel, dt);
        duck.mesh.rotation.z += dt * 7;
        duck.mesh.rotation.x += dt * 3;
        if (duck.pos.y <= 0.4) {
          duck.gone = true;
          duck.mesh.visible = false;
          const inPond = Math.hypot(duck.pos.x, duck.pos.z + 46) < 34;
          if (inPond) { sfx.splash(); } else { sfx.noise(0.2, 400, { gain: 0.14, q: 0.6 }); }
        }
      } else if (duck.alive) {
        duck.bobPhase += dt * duck.bobRate;
        duck.pos.addScaledVector(duck.vel, dt);
        duck.pos.y += Math.sin(duck.bobPhase) * 3.2 * dt;
        duck.flap += dt * 13;

        // flee upward once the wave is nearly out of time
        if (this.waveTime < 3.5) { duck.pos.y += 5 * dt; }

        if (Math.abs(duck.pos.x) > 85 || duck.pos.y > 40) {
          duck.gone = true;
          duck.mesh.visible = false;
        }
        if (Math.random() < dt * 0.12) { sfx.quack(); }
      }

      duck.mesh.position.copy(duck.pos);
      if (!duck.falling) {
        duck.mesh.rotation.y = duck.vel.x > 0 ? 0 : Math.PI;
        const beat = Math.sin(duck.flap) * 0.9;
        for (const w of duck.mesh.userData.wings) {
          w.pivot.rotation.x = beat * w.side;
        }
      }
    }
  }

  _endWave() {
    this.waveActive = false;
    this.betweenWaves = 2.0;
    const shot = this.ducks.filter(d => !d.alive).length;
    const total = this.ducks.length;
    if (shot === total) {
      this.ctx.ui.toast("PERFECT WAVE", "all " + total + " down", 1600);
      sfx.cheer(0.7);
      for (const p of this.players) {
        if (p.waveHits > 0) { p.score += 150; }
      }
    } else if (shot === 0) {
      this.ctx.ui.toast("THEY GOT AWAY", "", 1400);
      sfx.point(false);
    } else {
      this.ctx.ui.toast(shot + " of " + total, "", 1200);
    }
    this._syncHud();
  }

  _finish() {
    this.over = true;
    const ranked = [...this.players].sort((a, b) => b.score - a.score);
    const top = ranked[0];
    if (this.players.length > 1) {
      this.ctx.ui.toast("PLAYER " + (top.seat + 1) + " WINS",
        top.score + " points", 9000);
    } else {
      const acc = top.shotsFired ? Math.round(top.hits / top.shotsFired * 100) : 0;
      this.ctx.ui.toast("FINAL SCORE", top.score + "  -  " + acc + "% accuracy", 9000);
    }
    sfx.cheer(1);
    this.ctx.net.buzz(0, 300);
    this._syncHud();
  }

  // ------------------------------------------------------------ drawing

  _drawScopes() {
    const w = this.ctx.renderer.domElement.clientWidth;
    const h = this.ctx.renderer.domElement.clientHeight;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      const el = this.scopes[i];
      if (!el) { continue; }
      const v = p.aimPoint.clone().project(this.camera);
      const x = (v.x * 0.5 + 0.5) * w;
      const y = (-v.y * 0.5 + 0.5) * h;
      el.style.transform = "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px)"
        + " translate(-50%,-50%) scale(" + (1 + p.recoil * 0.25).toFixed(3) + ")";
      el.classList.toggle("empty", p.shells <= 0);
    }
  }

  _syncHud() {
    const cards = this.players.map((p, i) => {
      const shells = '<span class="shells">'
        + "●".repeat(Math.max(0, p.shells))
        + '<i>' + "○".repeat(Math.max(0, SHELLS - p.shells)) + '</i></span>';
      return '<div class="duckCard" style="--c:'
        + PLAYER_COLORS[i % PLAYER_COLORS.length] + '">'
        + (this.players.length > 1 ? '<span class="pnum">P' + (i + 1) + "</span>" : "")
        + '<span class="score">' + p.score + '</span>'
        + shells + '</div>';
    }).join("");

    const alive = this.ducks.filter(d => d.alive && !d.gone).length;
    this.ctx.ui.hud(
      '<div class="duckHud">' + cards + '</div>'
      + '<div class="hudSub">Wave ' + Math.min(this.wave, WAVES) + ' / ' + WAVES
      + (this.waveActive ? '  &middot;  ' + alive + ' up  &middot;  '
        + Math.max(0, Math.ceil(this.waveTime)) + 's' : '') + '</div>'
    );
  }
}
