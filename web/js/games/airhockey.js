/*
 * Air hockey.
 *
 * Tilt the phone to slide your mallet around your own half - forward and back
 * as well as side to side. The puck is almost frictionless, so pace comes from
 * how fast your mallet is actually moving when it makes contact, not from a
 * swing: the mallet's velocity is measured from where it was last frame and
 * handed to the puck.
 *
 * One shared top-down view rather than a split screen, because both players
 * need to see the whole table.
 */

import * as THREE from "../../lib/three.module.js";
import { addLights, skyDome, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";

const HALF_W = 0.5;           // table half-width
const HALF_L = 1.0;           // table half-length
const PUCK_R = 0.048;
const MALLET_R = 0.062;
const GOAL_HALF = 0.19;       // half the width of the mouth
const FRICTION = 0.16;        // air hockey is nearly frictionless
const MAX_PUCK = 4.2;
const WIN_SCORE = 7;

export class AirHockeyGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Air Hockey";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.02, 40);
    this.cameras = [this.camera];
    this._build();
  }

  _build() {
    const scene = this.scene;
    scene.add(skyDome(0x12182c, 0x39405a));
    addLights(scene, { sky: 0xdce8ff, ground: 0x2a3040, ambient: 1.0, sun: 1.0,
                       shadowRange: 3 });
    const lamp = new THREE.PointLight(0xdaf0ff, 10, 6, 2);
    lamp.position.set(0, 2.2, 0);
    scene.add(lamp);

    const bed = new THREE.Mesh(
      new THREE.BoxGeometry(HALF_W * 2, 0.04, HALF_L * 2),
      new THREE.MeshStandardMaterial({ color: 0xdfe8f2, roughness: 0.22, metalness: 0.1 })
    );
    bed.position.y = -0.02;
    bed.receiveShadow = true;
    scene.add(bed);

    // markings
    const line = (w, l, x, z, color, y) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l),
        new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, y || 0.002, z);
      scene.add(m);
      return m;
    };
    line(HALF_W * 2, 0.012, 0, 0, 0xd0402f);
    const circle = new THREE.Mesh(
      new THREE.RingGeometry(0.16, 0.172, 40),
      new THREE.MeshStandardMaterial({ color: 0xd0402f, side: THREE.DoubleSide })
    );
    circle.rotation.x = -Math.PI / 2;
    circle.position.y = 0.002;
    scene.add(circle);
    for (const sz of [-1, 1]) {
      const crease = new THREE.Mesh(
        new THREE.RingGeometry(0.22, 0.232, 32, 1, sz > 0 ? Math.PI : 0, Math.PI),
        new THREE.MeshStandardMaterial({ color: 0x2f6fe0, side: THREE.DoubleSide })
      );
      crease.rotation.x = -Math.PI / 2;
      crease.position.set(0, 0.002, sz * HALF_L);
      scene.add(crease);
    }

    // rails, with a gap left for each goal mouth
    const railMat = new THREE.MeshStandardMaterial({ color: 0x2b3350, roughness: 0.6 });
    for (const sx of [-1, 1]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.09, HALF_L * 2 + 0.05), railMat);
      rail.position.set(sx * (HALF_W + 0.025), 0.03, 0);
      rail.castShadow = true;
      scene.add(rail);
    }
    for (const sz of [-1, 1]) {
      for (const sx of [-1, 1]) {
        const len = HALF_W - GOAL_HALF;
        const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.09, 0.05), railMat);
        rail.position.set(sx * (GOAL_HALF + len / 2), 0.03, sz * (HALF_L + 0.025));
        rail.castShadow = true;
        scene.add(rail);
      }
      const mouth = new THREE.Mesh(
        new THREE.BoxGeometry(GOAL_HALF * 2, 0.07, 0.05),
        new THREE.MeshStandardMaterial({ color: 0x10141f, roughness: 1 })
      );
      mouth.position.set(0, 0.02, sz * (HALF_L + 0.025));
      scene.add(mouth);
    }

    this.puck = new THREE.Mesh(
      new THREE.CylinderGeometry(PUCK_R, PUCK_R, 0.02, 26),
      new THREE.MeshStandardMaterial({ color: 0x1b1f2a, roughness: 0.35 })
    );
    this.puck.castShadow = true;
    scene.add(this.puck);

    this.mallets = [];
    for (let i = 0; i < 2; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(MALLET_R, MALLET_R, 0.028, 24),
        new THREE.MeshStandardMaterial({
          color: i === 0 ? 0x3f7fe8 : 0xd0402f, roughness: 0.3, metalness: 0.2,
        })
      );
      body.position.y = 0.014;
      body.castShadow = true;
      g.add(body);
      const knob = new THREE.Mesh(
        new THREE.CylinderGeometry(MALLET_R * 0.45, MALLET_R * 0.5, 0.03, 18),
        new THREE.MeshStandardMaterial({
          color: i === 0 ? 0x2f6fe0 : 0xb0301f, roughness: 0.4,
        })
      );
      knob.position.y = 0.042;
      g.add(knob);
      scene.add(g);
      this.mallets.push(g);
    }

    this.camera.position.set(0, 2.35, 1.55);
    this.camera.lookAt(0, 0, 0);
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    this.twoPlayer = this.ctx.humanCount() >= 2;
    this.score = [0, 0];
    this.over = false;
    this.serveAt = 0;
    // side 0 defends +z (nearest the camera), side 1 defends -z
    this.pads = [
      { x: 0, z: HALF_L * 0.6, vx: 0, vz: 0 },
      { x: 0, z: -HALF_L * 0.6, vx: 0, vz: 0 },
    ];
    this._centre(1);
    this._brief();
    this._syncHud();
    this.ctx.ui.toast("AIR HOCKEY",
      "first to " + WIN_SCORE + (this.twoPlayer ? "" : "  ·  you defend the near goal"), 2000);
  }

  exit() { }

  _brief() {
    for (let i = 0; i < (this.twoPlayer ? 2 : 1); i++) {
      const c = this.ctx.seat(i);
      if (!c) { continue; }
      this.ctx.net.mode(c.pid,
        this.twoPlayer ? "Air Hockey - P" + (i + 1) : "Air Hockey",
        "Tilt to slide your mallet. Move it fast into the puck to hit hard.",
        "-", "no button needed - just tilt");
    }
  }

  _centre(towards) {
    this.puckPos = new THREE.Vector2(0, 0);
    this.puckVel = new THREE.Vector2(
      (Math.random() - 0.5) * 0.4, towards * (0.55 + Math.random() * 0.25));
    this.serveAt = performance.now() + 700;
  }

  // ------------------------------------------------------------ update

  update(dt, time) {
    const live = !this.over && performance.now() > this.serveAt;

    // --- mallets ---------------------------------------------------------
    for (let i = 0; i < 2; i++) {
      const pad = this.pads[i];
      const prevX = pad.x, prevZ = pad.z;
      const human = i === 0 || this.twoPlayer;

      if (human) {
        const c = this.ctx.seat(i);
        if (c) {
          // player two sits at the far end, so their axes are mirrored
          const flip = i === 1 ? -1 : 1;
          const wantX = clamp(c.aim, -1, 1) * flip * (HALF_W - MALLET_R);
          const wantZ = clamp(-c.lean, -1, 1) * flip * (HALF_L - MALLET_R) * 0.5
            + (i === 0 ? HALF_L * 0.5 : -HALF_L * 0.5);
          pad.x = damp(pad.x, wantX, 16, dt);
          pad.z = damp(pad.z, wantZ, 16, dt);
        }
      } else {
        this._ai(pad, dt, live);
      }

      // keep each mallet in its own half and on the table
      pad.x = clamp(pad.x, -HALF_W + MALLET_R, HALF_W - MALLET_R);
      pad.z = i === 0
        ? clamp(pad.z, MALLET_R * 0.5, HALF_L - MALLET_R)
        : clamp(pad.z, -HALF_L + MALLET_R, -MALLET_R * 0.5);

      pad.vx = (pad.x - prevX) / Math.max(dt, 1e-4);
      pad.vz = (pad.z - prevZ) / Math.max(dt, 1e-4);
      this.mallets[i].position.set(pad.x, 0, pad.z);
    }

    // --- puck ------------------------------------------------------------
    if (live) { this._puckStep(dt); }
    this.puck.position.set(this.puckPos.x, 0.012, this.puckPos.y);

    if (this.over && this.restartAt && performance.now() > this.restartAt) {
      this.restartAt = 0;
      this.enter();
      return;
    }

    this.ctx.ui.prompt(this.over ? ""
      : !live ? "" : this.twoPlayer ? "" : "Tilt to move your mallet");
  }

  _puckStep(dt) {
    const steps = 6;                  // the puck is fast; sub-step the contacts
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      this.puckPos.addScaledVector(this.puckVel, h);
      this.puckVel.multiplyScalar(Math.max(0, 1 - FRICTION * h));

      // side rails
      if (this.puckPos.x < -HALF_W + PUCK_R) {
        this.puckPos.x = -HALF_W + PUCK_R;
        this.puckVel.x = Math.abs(this.puckVel.x) * 0.94;
        this._tap();
      } else if (this.puckPos.x > HALF_W - PUCK_R) {
        this.puckPos.x = HALF_W - PUCK_R;
        this.puckVel.x = -Math.abs(this.puckVel.x) * 0.94;
        this._tap();
      }

      // ends: either a goal or the back rail
      for (const sz of [-1, 1]) {
        if (sz * this.puckPos.y < HALF_L - PUCK_R) { continue; }
        if (Math.abs(this.puckPos.x) < GOAL_HALF) {
          // sz +1 is the near goal, which side 0 defends
          this._goal(sz > 0 ? 1 : 0);
          return;
        }
        this.puckPos.y = sz * (HALF_L - PUCK_R);
        this.puckVel.y = -sz * Math.abs(this.puckVel.y) * 0.94;
        this._tap();
      }

      // mallets
      for (let i = 0; i < 2; i++) {
        const pad = this.pads[i];
        const dx = this.puckPos.x - pad.x, dz = this.puckPos.y - pad.z;
        const d = Math.hypot(dx, dz);
        const min = PUCK_R + MALLET_R;
        if (d >= min || d < 1e-6) { continue; }

        const nx = dx / d, nz = dz / d;
        this.puckPos.x = pad.x + nx * min;
        this.puckPos.y = pad.z + nz * min;

        // reflect about the contact normal, then add what the mallet is doing
        const along = this.puckVel.x * nx + this.puckVel.y * nz;
        if (along < 0) {
          this.puckVel.x -= 2 * along * nx;
          this.puckVel.y -= 2 * along * nz;
        }
        this.puckVel.x += nx * Math.abs(pad.vx * nx + pad.vz * nz) * 0.9 + pad.vx * 0.25;
        this.puckVel.y += nz * Math.abs(pad.vx * nx + pad.vz * nz) * 0.9 + pad.vz * 0.25;

        const speed = this.puckVel.length();
        if (speed > MAX_PUCK) { this.puckVel.multiplyScalar(MAX_PUCK / speed); }
        sfx.pinHit(clamp(speed / 3, 0.15, 1));
        this.ctx.net.buzz(0, 20, false);
      }
    }
  }

  _tap() {
    const s = this.puckVel.length();
    if (s > 0.4) { sfx.noise(0.05, 1200, { gain: clamp(s * 0.03, 0.03, 0.13), q: 2 }); }
  }

  _goal(scorer) {
    this.score[scorer]++;
    sfx.crash(0.7);
    sfx.cheer(0.5);
    this.ctx.net.buzz(0, 180);
    const who = this.twoPlayer ? "PLAYER " + (scorer + 1)
      : (scorer === 0 ? "YOU SCORE" : "CONCEDED");
    this.ctx.ui.toast(who, this.score[0] + " - " + this.score[1], 1600);

    if (this.score[scorer] >= WIN_SCORE) {
      this.over = true;
      this.restartAt = performance.now() + 9000;
      const win = this.twoPlayer ? "PLAYER " + (scorer + 1) + " WINS"
        : (scorer === 0 ? "YOU WIN!" : "YOU LOSE");
      this.ctx.ui.toast(win, this.score[0] + " - " + this.score[1], 9000);
      sfx.cheer(scorer === 0 ? 1 : 0.3);
    } else {
      // the player who conceded gets the puck
      this._centre(scorer === 0 ? -1 : 1);
    }
    this._syncHud();
  }

  /** Defend the goal line, and push forward when the puck is reachable. */
  _ai(pad, dt, live) {
    const puck = this.puckPos, vel = this.puckVel;
    const incoming = live && vel.y < -0.05;
    let targetX = puck.x * 0.85;
    let targetZ = -HALF_L * 0.72;

    if (incoming) {
      // where the puck will cross the mallet's line
      const t = (pad.z - puck.y) / vel.y;
      if (t > 0 && t < 1.4) { targetX = clamp(puck.x + vel.x * t, -HALF_W, HALF_W) * 0.95; }
      if (puck.y < -HALF_L * 0.25) { targetZ = clamp(puck.y + 0.1, -HALF_L * 0.85, -0.12); }
    } else if (puck.y < -0.1 && Math.abs(vel.y) < 0.4) {
      targetZ = puck.y - 0.02;          // nudge a stalled puck away
      targetX = puck.x;
    }
    pad.x = damp(pad.x, clamp(targetX, -HALF_W + MALLET_R, HALF_W - MALLET_R), 9, dt);
    pad.z = damp(pad.z, targetZ, 7, dt);
  }

  _syncHud() {
    const p1 = this.twoPlayer ? "P1" : "YOU";
    const p2 = this.twoPlayer ? "P2" : "CPU";
    this.ctx.ui.hud(
      '<div class="hudRow"><span class="tag blue">' + p1 + '</span>'
      + '<span class="big">' + this.score[0] + '</span>'
      + '<span class="sep">first to ' + WIN_SCORE + '</span>'
      + '<span class="big">' + this.score[1] + '</span>'
      + '<span class="tag red">' + p2 + '</span></div>'
      + '<div class="hudSub">' + (this.over ? "game over" : "") + '</div>');
  }
}
