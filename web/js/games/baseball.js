/*
 * Baseball - batting.
 *
 * A pitch comes in; swing to hit it. Timing is everything: the ball has to be
 * close to the plate when your swing lands. Swinging early pulls it, late
 * slices it the other way, and how hard you swing sets the distance.
 *
 * Three outs an innings, three innings each. Where the ball lands decides
 * whether it is caught, a single, a double, a triple or gone.
 */

import * as THREE from "../../lib/three.module.js";
import { addLights, skyDome, blobShadow, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";

const G = 9.81;
const PLATE_Z = 0;            // home plate sits at the origin
const MOUND_Z = -18.4;
const PLATE_Y = 1.0;          // where the ball crosses, roughly belt height
const FENCE = 92;             // distance to the wall
const OUTS_PER_INNINGS = 3;
const INNINGS = 3;
const CONTACT_WINDOW = 0.11;  // seconds either side of the plate that count

/*
 * Nine fielders, as [spray angle in degrees, distance from the plate, reach].
 * A ball landing inside a fielder's reach is caught, so where you place it
 * matters as much as how far it goes - pulling one into the gap is the way to
 * get on base. Deciding hits on distance alone made every ball in play a hit.
 */
const FIELDERS = [
  [0, 18, 4.5],     // pitcher
  [34, 27, 5.5],    // first base
  [15, 40, 6],      // second base
  [-15, 40, 6],     // shortstop
  [-34, 27, 5.5],   // third base
  [-30, 68, 9],     // left field
  [0, 78, 9.5],     // centre field
  [30, 68, 9],      // right field
];

export class BaseballGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Baseball";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 400);
    this.cameras = [this.camera];
    this._build();
  }

  _build() {
    const scene = this.scene;
    scene.add(skyDome(0x2f6bb8, 0xbcd8f0));
    scene.fog = new THREE.Fog(0xa8c4dd, 130, 320);
    addLights(scene, { sky: 0xdfeaff, ground: 0x5a6b32, ambient: 1.0, sun: 1.3,
                       shadowRange: 26 });

    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: 0x3f7a38, roughness: 0.97 })
    );
    grass.rotation.x = -Math.PI / 2;
    grass.receiveShadow = true;
    scene.add(grass);

    // infield dirt
    const dirt = new THREE.Mesh(
      new THREE.CircleGeometry(29, 40, Math.PI * 0.25, Math.PI * 0.5),
      new THREE.MeshStandardMaterial({ color: 0xa9793f, roughness: 0.95 })
    );
    dirt.rotation.x = -Math.PI / 2;
    dirt.position.set(0, 0.01, 0);
    scene.add(dirt);

    const mound = new THREE.Mesh(
      new THREE.CylinderGeometry(2.7, 3, 0.25, 24),
      new THREE.MeshStandardMaterial({ color: 0xb98a4d, roughness: 0.95 })
    );
    mound.position.set(0, 0.1, MOUND_Z);
    scene.add(mound);

    const plate = new THREE.Mesh(
      new THREE.CircleGeometry(0.42, 5),
      new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 })
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(0, 0.02, PLATE_Z);
    scene.add(plate);

    // foul lines and the outfield wall
    for (const s of [-1, 1]) {
      const foul = new THREE.Mesh(
        new THREE.PlaneGeometry(0.22, FENCE * 1.5),
        new THREE.MeshStandardMaterial({ color: 0xf0f0f0 })
      );
      foul.rotation.x = -Math.PI / 2;
      foul.rotation.z = s * Math.PI / 4;
      foul.position.set(s * FENCE * 0.53, 0.02, -FENCE * 0.53);
      scene.add(foul);
    }
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(FENCE, FENCE, 3.4, 60, 1, true,
        Math.PI * 0.25, Math.PI * 0.5),
      new THREE.MeshStandardMaterial({
        color: 0x2b4a6b, roughness: 0.9, side: THREE.DoubleSide,
      })
    );
    wall.position.set(0, 1.7, 0);
    scene.add(wall);

    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.037, 14, 12),
      new THREE.MeshStandardMaterial({ color: 0xfdfdf5, roughness: 0.5 })
    );
    this.ball.castShadow = true;
    scene.add(this.ball);
    this.ballShadow = blobShadow(0.5);
    scene.add(this.ballShadow);

    // a marker showing where the pitch will cross the plate
    this.target = new THREE.Mesh(
      new THREE.RingGeometry(0.1, 0.13, 20),
      new THREE.MeshBasicMaterial({
        color: 0xffd166, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
      })
    );
    scene.add(this.target);

    this.camera.position.set(0, 2.5, 5.2);
    this.camera.lookAt(0, 1.4, MOUND_Z * 0.35);
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    const n = Math.min(2, this.ctx.humanCount());
    this.players = [];
    for (let i = 0; i < n; i++) {
      this.players.push({ seat: i, runs: 0, hits: 0, homers: 0, atBats: 0 });
    }
    this.active = 0;
    this.innings = 1;
    this.outs = 0;
    this.strikes = 0;
    this.bases = [false, false, false];
    this.over = false;
    this.pitch = null;
    this.hit = null;
    this.nextAt = performance.now() + 1400;
    this.swungAt = 0;
    this._brief();
    this._syncHud();
    this.ctx.ui.toast("BASEBALL",
      n > 1 ? "Three innings each" : "Three innings  ·  swing when it reaches the plate", 2200);
  }

  exit() { }

  _brief() {
    for (let i = 0; i < this.players.length; i++) {
      const c = this.ctx.seat(i);
      if (!c) { continue; }
      this.ctx.net.mode(c.pid,
        this.players.length > 1 ? "Baseball - P" + (i + 1) : "Baseball",
        "Swing as the ball reaches the plate. Early pulls it, late slices it.",
        "SWING", "Swing the phone to bat");
    }
  }

  _throwPitch() {
    // a mix of speeds and locations, so timing has to be judged each time
    const speed = 30 + Math.random() * 12;            // metres per second
    const flight = Math.abs(MOUND_Z) / speed;
    const aimX = (Math.random() - 0.5) * 0.62;
    const aimY = PLATE_Y + (Math.random() - 0.5) * 0.5;
    const startY = 1.9;

    this.pitch = {
      t: 0, flight,
      from: new THREE.Vector3(0, startY, MOUND_Z),
      to: new THREE.Vector3(aimX, aimY, PLATE_Z),
      // a little late break so it is not a dead straight line
      curve: (Math.random() - 0.5) * 0.5,
      speed,
    };
    this.target.position.set(aimX, aimY, PLATE_Z + 0.05);
    this.target.lookAt(this.camera.position);
    sfx.whoosh();
  }

  onSwing(swing) {
    if (this.over || this.hit) { return; }
    const seat = this.ctx.seatOf(swing.pid);
    if (seat !== this.active || seat < 0) { return; }
    if (!this.pitch) { return; }
    if (this.swungAt) { return; }
    this.swungAt = this.pitch.t;
    this._contact(swing);
  }

  _contact(swing) {
    const p = this.pitch;
    // how far from the plate the ball was when the swing landed
    const err = p.t - p.flight;
    const absErr = Math.abs(err);

    if (absErr > CONTACT_WINDOW) {
      this._strike("swing and a miss");
      return;
    }

    // timing decides the direction: early pulls, late goes the other way
    const timing = clamp(err / CONTACT_WINDOW, -1, 1);
    const quality = 1 - absErr / CONTACT_WINDOW;      // 1 = dead on
    const foul = quality < 0.3;

    /*
     * Exit speed has to be scaled to the park. A ball leaving at v metres per
     * second carries v^2 sin(2a) / g, so clearing the 92 m fence needs roughly
     * 34 m/s at a sensible launch angle - and no more. An earlier version
     * topped out near 58 m/s, which put every single well-timed swing over the
     * wall and meant an innings could never end.
     */
    const spray = -timing * 42 + (Math.random() - 0.5) * 10;   // degrees off centre
    // Clean contact should leave on a useful trajectory by itself; the mishit
    // loft is a smaller correction. Basing the angle mostly on the mishit term
    // meant a perfectly timed swing came off as a flat liner straight at an
    // outfielder, so good timing scored worse than bad.
    const launch = clamp(26 + swing.lean * 12 + (1 - quality) * 10, 8, 48);
    // Contact quality is worth far more than raw swing speed. Weighting them
    // the other way meant a wild uppercut cleared the fence as often as a
    // well-timed swing, so there was no reason to time anything.
    const power = (12 + swing.power * 6 + quality * 16)
      * (1 + (Math.random() - 0.5) * 0.09);

    const a = spray * Math.PI / 180;
    const rad = launch * Math.PI / 180;
    this.hit = {
      pos: new THREE.Vector3(0, PLATE_Y, PLATE_Z),
      vel: new THREE.Vector3(
        Math.sin(a) * Math.cos(rad) * power,
        Math.sin(rad) * power,
        -Math.cos(a) * Math.cos(rad) * power),
      t: 0, foul, spray, launch, settled: false,
    };
    this.pitch = null;
    sfx.racket(quality);
    this.ctx.net.buzz(swing.pid, 40 + quality * 60);
    if (quality > 0.8) { this.ctx.ui.toast("CRACK!", "", 900); }
  }

  _stepHit(dt) {
    const h = this.hit;
    h.t += dt;
    h.vel.y -= G * dt;
    h.vel.multiplyScalar(1 - 0.055 * dt);      // enough drag to punish pure loft
    h.pos.addScaledVector(h.vel, dt);

    if (h.pos.y <= 0.04 && h.vel.y < 0) {
      h.pos.y = 0.04;
      h.vel.y = -h.vel.y * 0.4;
      h.vel.x *= 0.6; h.vel.z *= 0.6;
      if (!h.landed) {
        h.landed = true;
        h.landDist = Math.hypot(h.pos.x, h.pos.z);
        h.hang = h.t;
      }
      if (h.vel.length() < 2 && !h.settled) { h.settled = true; this._resolveHit(); }
    }
    const dist = Math.hypot(h.pos.x, h.pos.z);
    if (dist > FENCE && h.pos.y > 0.6 && !h.settled) {
      h.settled = true;
      this._resolveHit(true);
    }
    if (h.t > 9 && !h.settled) { h.settled = true; this._resolveHit(); }
  }

  _resolveHit(overFence) {
    const h = this.hit;
    const p = this.players[this.active];
    const dist = h.landDist || Math.hypot(h.pos.x, h.pos.z);
    const foulBall = Math.abs(h.spray) > 45;

    if (foulBall && !overFence) {
      this.hit = null;
      this._strike("foul ball", true);
      return;
    }

    p.atBats++;
    let bases = 0;
    let label, detail;
    // a steep, short ball is a pop-up and is caught wherever it lands
    const popUp = h.launch > 40 && dist < 78;
    const fielder = this._nearestFielder(h.spray, dist, h.hang || h.t);

    if (overFence) {
      bases = 4; p.homers++;
      label = "HOME RUN!"; detail = Math.round(dist) + " metres";
      sfx.cheer(1);
    } else if (popUp) {
      label = "POPPED UP"; detail = "caught";
    } else if (fielder) {
      label = "CAUGHT"; detail = "right at a fielder, " + Math.round(dist) + "m";
    } else if (dist < 50) {
      // weak contact dies in the infield; it should not be a cheap single
      label = "GROUNDED OUT"; detail = Math.round(dist) + "m";
    } else if (dist < 66) {
      bases = 1; label = "SINGLE"; detail = "into the gap, " + Math.round(dist) + "m";
    } else if (dist < 84) {
      bases = 2; label = "DOUBLE"; detail = Math.round(dist) + "m";
    } else {
      bases = 3; label = "TRIPLE"; detail = Math.round(dist) + "m";
    }

    if (bases === 0) {
      this.outs++;
      sfx.point(false);
    } else {
      p.hits++;
      sfx.point(true);
      this._advance(bases);
    }
    this.ctx.ui.toast(label, detail, 1900);
    this.hit = null;
    this.strikes = 0;
    this._afterPlay();
  }

  /**
   * Can a fielder get to where this ball comes down?
   *
   * Their reach grows with how long the ball is in the air, because that is
   * the time they have to run. So a towering fly is nearly always caught while
   * a low screamer into the gap drops in - which is what makes the launch
   * angle worth controlling. Judging it on landing distance alone let weak,
   * short hits fall safe more often than well-struck ones.
   */
  _nearestFielder(spray, dist, hang) {
    const a = spray * Math.PI / 180;
    const bx = Math.sin(a) * dist, bz = Math.cos(a) * dist;
    const run = clamp(2.0 * hang, 0, 6.5);
    for (const [deg, d, reach] of FIELDERS) {
      const fa = deg * Math.PI / 180;
      const fx = Math.sin(fa) * d, fz = Math.cos(fa) * d;
      if (Math.hypot(bx - fx, bz - fz) < reach + run) { return true; }
    }
    return false;
  }

  _advance(bases) {
    const p = this.players[this.active];
    // walk the runners round; anything past third is a run
    for (let b = 2; b >= 0; b--) {
      if (!this.bases[b]) { continue; }
      this.bases[b] = false;
      const to = b + bases;
      if (to >= 3) { p.runs++; } else { this.bases[to] = true; }
    }
    if (bases >= 4) { p.runs++; } else { this.bases[bases - 1] = true; }
  }

  _strike(reason, foulOnly) {
    if (foulOnly && this.strikes >= 2) {
      this.ctx.ui.toast("FOUL", "still two strikes", 1200);
    } else {
      this.strikes++;
    }
    sfx.noise(0.07, 900, { gain: 0.12, q: 1.5 });
    if (this.strikes >= 3) {
      this.strikes = 0;
      this.outs++;
      this.players[this.active].atBats++;
      this.ctx.ui.toast("STRUCK OUT", "", 1500);
      sfx.point(false);
    } else if (!foulOnly) {
      this.ctx.ui.toast("STRIKE " + this.strikes, reason, 1100);
    }
    this.pitch = null;
    this._afterPlay();
  }

  _afterPlay() {
    this.swungAt = 0;
    if (this.outs >= OUTS_PER_INNINGS) {
      this.outs = 0;
      this.strikes = 0;
      this.bases = [false, false, false];
      if (this.players.length > 1) {
        if (this.active === 1) { this.innings++; }
        this.active = 1 - this.active;
      } else {
        this.innings++;
      }
      if (this.innings > INNINGS) { this._finish(); return; }
      this.ctx.ui.toast("INNINGS " + this.innings,
        this.players.length > 1 ? "Player " + (this.active + 1) + " to bat" : "", 1800);
    }
    this.nextAt = performance.now() + 1700;
    this._syncHud();
  }

  _finish() {
    this.over = true;
    this.restartAt = performance.now() + 11000;
    const ranked = [...this.players].sort((a, b) => b.runs - a.runs);
    if (this.players.length > 1) {
      this.ctx.ui.toast(
        ranked[0].runs === ranked[1].runs ? "TIED"
          : "PLAYER " + (ranked[0].seat + 1) + " WINS",
        ranked[0].runs + " - " + ranked[1].runs, 11000);
    } else {
      const p = this.players[0];
      this.ctx.ui.toast("GAME OVER",
        p.runs + " runs  ·  " + p.hits + " hits  ·  " + p.homers + " home runs", 11000);
    }
    sfx.cheer(1);
    this._syncHud();
  }

  // ------------------------------------------------------------ update

  update(dt, time) {
    if (this.over) {
      if (this.restartAt && performance.now() > this.restartAt) {
        this.restartAt = 0; this.enter(); return;
      }
    } else if (this.hit) {
      this._stepHit(dt);
    } else if (this.pitch) {
      const p = this.pitch;
      p.t += dt;
      const k = clamp(p.t / p.flight, 0, 1.5);
      const x = lerp(p.from.x, p.to.x, k) + Math.sin(k * Math.PI) * p.curve;
      const y = lerp(p.from.y, p.to.y, k) - Math.sin(k * Math.PI) * 0.22;
      const z = lerp(p.from.z, p.to.z, k);
      this.ball.position.set(x, y, z);
      if (p.t > p.flight + CONTACT_WINDOW) {
        if (!this.swungAt) { this._strike("caught looking"); }
        else { this._strike("swing and a miss"); }
      }
    } else if (this.nextAt && performance.now() > this.nextAt) {
      this.nextAt = 0;
      this._throwPitch();
    }

    if (this.hit) { this.ball.position.copy(this.hit.pos); }
    this.ball.visible = !!(this.pitch || this.hit);
    this.ballShadow.visible = this.ball.visible;
    this.ballShadow.position.set(this.ball.position.x, 0.03, this.ball.position.z);
    const hgt = clamp(this.ball.position.y, 0, 30);
    this.ballShadow.scale.setScalar(clamp(1.4 - hgt / 26, 0.35, 1.4));

    this.target.visible = !!this.pitch && !this.hit;

    // follow a struck ball out into the field
    if (this.hit) {
      const d = Math.hypot(this.hit.pos.x, this.hit.pos.z);
      this.camera.position.y = damp(this.camera.position.y, 2.5 + d * 0.12, 2, dt);
      this.camera.position.z = damp(this.camera.position.z, 5.2 + d * 0.06, 2, dt);
      this.camera.lookAt(this.hit.pos.x * 0.5, Math.max(1, this.hit.pos.y * 0.5),
        this.hit.pos.z * 0.5);
    } else {
      this.camera.position.x = damp(this.camera.position.x, 0, 3, dt);
      this.camera.position.y = damp(this.camera.position.y, 2.5, 3, dt);
      this.camera.position.z = damp(this.camera.position.z, 5.2, 3, dt);
      this.camera.lookAt(0, 1.4, MOUND_Z * 0.35);
    }

    this.ctx.ui.prompt(this.over ? ""
      : this.hit ? ""
        : this.pitch ? "Swing now!"
          : this.players.length > 1
            ? "Player " + (this.active + 1) + " batting" : "");
    this._syncHud();
  }

  _syncHud() {
    const diamond = this.bases.map((b, i) =>
      '<i class="' + (b ? "on" : "") + '">' + (i + 1) + '</i>').join("");
    const cards = this.players.map((p, i) =>
      '<div class="shotCard' + (i === this.active && !this.over ? " on" : "") + '">'
      + (this.players.length > 1 ? '<span class="tag ' + (i ? "red" : "blue")
         + '">P' + (i + 1) + "</span>" : "")
      + '<span class="big">' + p.runs + '</span>'
      + '<span class="sub">' + p.hits + " hits  ·  " + p.homers + " HR</span></div>").join("");
    this.ctx.ui.hud('<div class="shotHud">' + cards + '</div>'
      + '<div class="hudSub">Innings ' + Math.min(this.innings, INNINGS) + '/' + INNINGS
      + '  &middot;  ' + this.outs + ' out  &middot;  ' + this.strikes + ' strikes'
      + '  &middot;  <span class="bases">' + diamond + '</span></div>');
  }
}
