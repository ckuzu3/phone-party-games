/*
 * Bowling.
 *
 * Tilt the phone to slide left and right on the approach, then swing your arm
 * down and forward to bowl. Swing speed is power; how much your wrist turns is
 * the hook.
 *
 * There are two ways to release, because people reach for both: hold the
 * button and let go at the bottom of the swing for deliberate control, or just
 * swing and let the arc itself decide. Either must work on its own - relying
 * on the button alone left players stuck with a ball that never left the hand.
 */

import * as THREE from "../../lib/three.module.js";
import { makeAthlete, addLights, idlePose, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";

const LANE_HALF = 0.5283;      // regulation lane is 1.0566 m wide
const FOUL_Z = 0;
const PIN_Z = 18.29;
const BALL_R = 0.1085;
const PIN_R = 0.061;
const PIN_H = 0.381;
const SPACING = 0.3048;
const ROW_DZ = SPACING * Math.cos(Math.PI / 6);
const GENTLE_SWING = 7.0;      // m/s^2 that counts as a bowling arm-swing
const GENTLE_RELEASE = 3.5;    // ...and the level it must fall back below
const HOOK = 0.38;             // lateral pull at full wrist turn, tuned so the
                               // hardest hook bends roughly 0.4 m by the pins

const STATE = { AIM: "aim", WINDUP: "windup", ROLL: "roll", SETTLE: "settle", DONE: "done" };

export class BowlingGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Bowling";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.05, 300);
    this._build();
  }

  // ------------------------------------------------------------ scenery

  _build() {
    const scene = this.scene;
    scene.background = new THREE.Color(0x141a2c);
    scene.fog = new THREE.Fog(0x141a2c, 22, 46);
    addLights(scene, { sky: 0x9fb6e8, ground: 0x30240f, ambient: 0.6, sun: 1.1, shadowRange: 12 });

    const strip = new THREE.PointLight(0xffe9c4, 26, 30, 2);
    strip.position.set(0, 4.2, PIN_Z - 1.2);
    scene.add(strip);

    // lane
    const lane = new THREE.Mesh(
      new THREE.PlaneGeometry(LANE_HALF * 2, PIN_Z + 3.2),
      new THREE.MeshStandardMaterial({ color: 0xc7924f, roughness: 0.18, metalness: 0.05 })
    );
    lane.rotation.x = -Math.PI / 2;
    lane.position.set(0, 0, (PIN_Z + 3.2) / 2 - 1.6);
    lane.receiveShadow = true;
    scene.add(lane);

    // board seams so speed is readable
    const seam = new THREE.MeshStandardMaterial({ color: 0xa9763b, roughness: 0.25 });
    for (let i = -6; i <= 6; i++) {
      if (i === 0) { continue; }
      const s = new THREE.Mesh(new THREE.PlaneGeometry(0.006, PIN_Z + 3.2), seam);
      s.rotation.x = -Math.PI / 2;
      s.position.set(i * (LANE_HALF / 7), 0.002, (PIN_Z + 3.2) / 2 - 1.6);
      scene.add(s);
    }

    // aiming arrows, as on a real lane
    const arrowMat = new THREE.MeshStandardMaterial({ color: 0x6b3f16, roughness: 0.4 });
    for (let i = -3; i <= 3; i++) {
      if (i === 0) { continue; }
      const a = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.12, 3), arrowMat);
      a.rotation.x = -Math.PI / 2;
      a.position.set(i * 0.1, 0.003, 4.2 + Math.abs(i) * 0.35);
      scene.add(a);
    }

    // gutters
    const gutterMat = new THREE.MeshStandardMaterial({ color: 0x2b3350, roughness: 0.5 });
    for (const side of [-1, 1]) {
      const g = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, PIN_Z + 3.2), gutterMat);
      g.position.set(side * (LANE_HALF + 0.13), -0.06, (PIN_Z + 3.2) / 2 - 1.6);
      g.receiveShadow = true;
      scene.add(g);
    }

    // approach + surroundings
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 46),
      new THREE.MeshStandardMaterial({ color: 0x232a44, roughness: 0.85 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -0.13, 6);
    floor.receiveShadow = true;
    scene.add(floor);

    const pinDeck = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 0.02, 1.4),
      new THREE.MeshStandardMaterial({ color: 0xe7e0cf, roughness: 0.35 })
    );
    pinDeck.position.set(0, 0.004, PIN_Z + 0.5);
    scene.add(pinDeck);

    // back wall + pit
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(6, 3.4, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x18203a, roughness: 0.9 })
    );
    wall.position.set(0, 1.7, PIN_Z + 1.9);
    scene.add(wall);

    const pit = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 0.5, 1.0),
      new THREE.MeshStandardMaterial({ color: 0x0d1120, roughness: 1 })
    );
    pit.position.set(0, -0.26, PIN_Z + 1.3);
    scene.add(pit);

    // side dividers
    const divMat = new THREE.MeshStandardMaterial({ color: 0x2a3355, roughness: 0.8 });
    for (const side of [-1, 1]) {
      const d = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.0, PIN_Z + 4), divMat);
      d.position.set(side * 1.5, 0.4, (PIN_Z) / 2);
      scene.add(d);
    }

    this._makeBall();
    this._makePins();

    this.bowler = makeAthlete(0x39c58a, { pants: 0x2a2f45 });
    this.bowler.position.set(0, 0, -1.3);
    scene.add(this.bowler);

    // aim guide
    this.guide = new THREE.Mesh(
      new THREE.PlaneGeometry(0.05, 7),
      new THREE.MeshBasicMaterial({
        color: 0x7fe3ff, transparent: true, opacity: 0.35, depthWrite: false,
      })
    );
    this.guide.rotation.x = -Math.PI / 2;
    scene.add(this.guide);

    this.camera.position.set(0, 1.75, -3.6);
    this.camera.lookAt(0, 0.5, 8);
  }

  _makeBall() {
    this.ballMesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 26, 20),
      new THREE.MeshStandardMaterial({
        color: 0x1b2b8f, roughness: 0.12, metalness: 0.35,
      })
    );
    this.ballMesh.castShadow = true;
    this.scene.add(this.ballMesh);

    // finger holes, so the spin is visible
    const holeMat = new THREE.MeshStandardMaterial({ color: 0x0a0f2a, roughness: 0.9 });
    for (const off of [[-0.035, 0.03], [0.035, 0.03], [0, -0.035]]) {
      const h = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.06, 8), holeMat);
      h.position.set(off[0], BALL_R - 0.012, off[1]);
      this.ballMesh.add(h);
    }
  }

  _pinGeometry() {
    // a lathe profile gives the real bowling-pin silhouette
    const profile = [
      [0.001, 0], [0.052, 0.004], [0.058, 0.03], [0.055, 0.07],
      [0.045, 0.125], [0.036, 0.18], [0.0335, 0.222], [0.038, 0.262],
      [0.0425, 0.292], [0.039, 0.322], [0.027, 0.355], [0.0205, 0.374],
      [0.014, 0.381], [0.001, 0.3815],
    ];
    return new THREE.LatheGeometry(
      profile.map(p => new THREE.Vector2(p[0], p[1])), 18);
  }

  _makePins() {
    const geo = this._pinGeometry();
    const white = new THREE.MeshStandardMaterial({ color: 0xf7f5ee, roughness: 0.32 });
    const red = new THREE.MeshStandardMaterial({ color: 0xd8443a, roughness: 0.35 });

    // standard triangle, apex toward the bowler
    const layout = [
      [0, 0],
      [-SPACING / 2, ROW_DZ], [SPACING / 2, ROW_DZ],
      [-SPACING, ROW_DZ * 2], [0, ROW_DZ * 2], [SPACING, ROW_DZ * 2],
      [-SPACING * 1.5, ROW_DZ * 3], [-SPACING / 2, ROW_DZ * 3],
      [SPACING / 2, ROW_DZ * 3], [SPACING * 1.5, ROW_DZ * 3],
    ];

    this.pins = [];
    for (let i = 0; i < layout.length; i++) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(geo, white);
      body.castShadow = true;
      group.add(body);
      for (const y of [0.268, 0.3]) {
        const stripe = new THREE.Mesh(
          new THREE.TorusGeometry(0.0415, 0.006, 6, 18), red);
        stripe.rotation.x = Math.PI / 2;
        stripe.position.y = y;
        group.add(stripe);
      }
      this.scene.add(group);
      this.pins.push({
        mesh: group,
        home: new THREE.Vector2(layout[i][0], PIN_Z + layout[i][1]),
        pos: new THREE.Vector2(),
        vel: new THREE.Vector2(),
        tilt: 0, tiltVel: 0,
        tiltAxis: new THREE.Vector2(1, 0),
        spin: 0,
        down: false,
        standing: true,
      });
    }
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    this.frame = 1;
    this.rolls = [];          // pinfall per roll, in order
    this.frameRolls = [];     // rolls within the current frame
    this.total = 0;
    this.startX = 0;
    this.aimAngle = 0;
    this.state = STATE.AIM;
    this.stateAt = performance.now();
    this.windPeak = 0;
    this.windYaw = 0;
    this.armAnim = 0;
    this.gutter = false;
    this.rolled = false;
    this.pinsBefore = 10;

    this._rackPins(true);
    this._resetBall();
    this._syncHud();

    const c = this.ctx.seat(0);
    this.ctx.net.mode(
      c ? c.pid : 0, "Bowling",
      "Tilt to slide across the approach, then swing your arm down and "
      + "forward to bowl.",
      "HOLD", "Optional: hold, swing, let go to release exactly when you want"
    );
    this.ctx.ui.toast("BOWLING", "Hold, swing, release", 1900);
  }

  exit() { }

  _resetBall() {
    this.ball = {
      pos: new THREE.Vector3(this.startX, BALL_R, FOUL_Z - 0.4),
      vel: new THREE.Vector3(0, 0, 0),
      spin: 0,
      dist: 0,
      live: false,
      inGutter: false,
    };
    this.ballMesh.position.copy(this.ball.pos);
    this.ballMesh.rotation.set(0, 0, 0);
    this.gutter = false;
  }

  _rackPins(all) {
    for (const pin of this.pins) {
      if (all || pin.down) {
        pin.standing = all ? true : pin.standing;
      }
    }
    for (const pin of this.pins) {
      if (all) { pin.standing = true; }
      if (!pin.standing) { pin.mesh.visible = false; continue; }
      pin.mesh.visible = true;
      pin.pos.set(pin.home.x, pin.home.y);
      pin.vel.set(0, 0);
      pin.tilt = 0; pin.tiltVel = 0; pin.spin = 0;
      pin.down = false;
      pin.mesh.position.set(pin.pos.x, 0, pin.pos.y);
      pin.mesh.rotation.set(0, 0, 0);
    }
  }

  _standingCount() {
    return this.pins.filter(p => p.standing && !p.down).length;
  }

  // ------------------------------------------------------------ input

  onButton(down, pid) {
    // bowling is one bowler at a time, so a second phone must not throw the ball
    if (pid !== undefined && this.ctx.seatOf(pid) > 0) { return; }
    if (this.state === STATE.AIM && down) {
      this.state = STATE.WINDUP;
      this.windPeak = 0;
      this.windYaw = 0;
      this.stateAt = performance.now();
      this.ctx.ui.prompt("Swing down and forward, then release");
      return;
    }
    if (this.state === STATE.WINDUP && !down) {
      this._throw(this.windPeak, this.windYaw);
    }
  }

  onSwing(swing) {
    if (this.ctx.seatOf(swing.pid) > 0) { return; }
    // a plain swing without holding the button still bowls, to stay forgiving
    if (this.state === STATE.AIM) {
      this._throw(swing.peak, swing.yaw);
    }
  }

  _throw(peak, yaw) {
    if (this.state === STATE.ROLL || this.state === STATE.SETTLE) { return; }
    const power = clamp((peak - 8) / 26, 0.12, 1);
    const speed = lerp(5.2, 11.4, power);
    const hook = clamp(yaw / 450, -1, 1);

    this.ball.pos.set(this.startX, BALL_R, FOUL_Z - 0.2);
    this.ball.vel.set(Math.sin(this.aimAngle) * speed, 0, Math.cos(this.aimAngle) * speed);
    this.ball.spin = hook;
    this.ball.dist = 0;
    this.ball.live = true;
    this.ball.inGutter = false;

    this.state = STATE.ROLL;
    this.stateAt = performance.now();
    this.armAnim = 0;
    this.rolled = true;
    this.windPeak = 0;
    this.windYaw = 0;

    sfx.roll(power);
    this.ctx.net.buzz(0, 40);
    this.ctx.ui.prompt("");
  }

  // ------------------------------------------------------------ scoring

  /** Classic ten-pin scoring over the flat roll list. */
  _computeScore() {
    const r = this.rolls;
    const frames = [];
    let total = 0;
    let i = 0;
    for (let f = 0; f < 10; f++) {
      if (i >= r.length) { break; }
      if (r[i] === 10) {                       // strike
        if (i + 2 < r.length) {
          total += 10 + r[i + 1] + r[i + 2];
          frames.push(total);
        } else {
          frames.push(null);
        }
        i += 1;
      } else if (i + 1 < r.length) {
        const sum = r[i] + r[i + 1];
        if (sum === 10) {                      // spare
          if (i + 2 < r.length) {
            total += 10 + r[i + 2];
            frames.push(total);
          } else {
            frames.push(null);
          }
        } else {
          total += sum;
          frames.push(total);
        }
        i += 2;
      } else {
        frames.push(null);
        break;
      }
    }
    return { frames, total };
  }

  _rollMark(f, idx, value, prev) {
    if (value === null || value === undefined) { return "&nbsp;"; }
    if (idx === 0 && value === 10 && f < 9) { return "X"; }
    if (idx > 0 && prev !== 10 && prev + value === 10) { return "/"; }
    if (value === 10) { return "X"; }
    return value === 0 ? "-" : String(value);
  }

  _syncHud() {
    const { frames, total } = this._computeScore();
    // rebuild the per-frame roll grid from the flat list
    const grid = [];
    let i = 0;
    for (let f = 0; f < 10; f++) {
      const cell = [];
      if (f < 9) {
        if (this.rolls[i] === 10) { cell.push(10); i += 1; }
        else { cell.push(this.rolls[i]); cell.push(this.rolls[i + 1]); i += 2; }
      } else {
        cell.push(this.rolls[i], this.rolls[i + 1], this.rolls[i + 2]);
      }
      grid.push(cell);
    }

    let html = '<div class="frames">';
    for (let f = 0; f < 10; f++) {
      const cell = grid[f];
      const active = (f + 1) === this.frame ? " on" : "";
      let marks = "";
      for (let k = 0; k < (f === 9 ? 3 : 2); k++) {
        const v = cell[k];
        marks += '<i>' + (v === undefined || v === null ? "&nbsp;"
          : this._rollMark(f, k, v, cell[k - 1])) + '</i>';
      }
      html += '<div class="frame' + active + '"><u>' + (f + 1) + '</u>'
        + '<div class="marks">' + marks + '</div>'
        + '<b>' + (frames[f] === null || frames[f] === undefined ? "" : frames[f]) + '</b></div>';
    }
    html += '</div>';
    this.ctx.ui.hud(html + '<div class="hudSub">Total ' + total + '</div>');
    this.total = total;
  }

  // ------------------------------------------------------------ update

  update(dt, time) {
    const c = this.ctx.seat(0);

    if (this.state === STATE.AIM || this.state === STATE.WINDUP) {
      if (c) {
        this.startX = damp(this.startX, clamp(c.aim, -1, 1) * (LANE_HALF - BALL_R - 0.02) * 1.5,
          5, dt);
        this.startX = clamp(this.startX, -LANE_HALF + BALL_R, LANE_HALF - BALL_R);
        this.aimAngle = clamp(-c.lean * 0.09, -0.075, 0.075);

        // Track the swing in both states, not just while the button is held.
        if (c.speed > this.windPeak) {
          this.windPeak = c.speed;
          this.windYaw = c.yaw;
        }

        // A bowling delivery is a smooth pendulum arc, which often never
        // reaches the sharp acceleration spike the generic swing detector
        // looks for - so bowling watches for its own gentler arc and lets go
        // of the ball as the arm slows at the bottom. Without this a controlled
        // swing simply did nothing.
        if (this.state === STATE.AIM
            && this.windPeak > GENTLE_SWING && c.speed < GENTLE_RELEASE) {
          this._throw(this.windPeak, this.windYaw);
        }
      }
      if (this.state === STATE.AIM || this.state === STATE.WINDUP) {
        this.ball.pos.set(this.startX, BALL_R, FOUL_Z - 0.4);
      }
      this.ctx.ui.prompt(this.state === STATE.AIM
        ? "Tilt to aim - then swing your arm down and forward"
        : "Swing down and forward, then release to bowl");
    }

    if (this.state === STATE.ROLL) { this._rollPhysics(dt); }
    this._pinPhysics(dt);
    this._settleCheck();
    this._animate(dt, time);
    this._camera(dt);
  }

  _rollPhysics(dt) {
    const b = this.ball;
    if (!b.live) { return; }

    if (!b.inGutter) {
      // hook: the ball grips more as the oil runs out further down the lane
      const grip = clamp((b.dist - 3.5) / 9, 0, 1);
      b.vel.x += b.spin * HOOK * grip * dt;
      b.vel.multiplyScalar(1 - 0.12 * dt);
    } else {
      b.vel.x = 0;
      b.vel.multiplyScalar(1 - 0.5 * dt);
    }

    b.pos.addScaledVector(b.vel, dt);
    b.dist += Math.abs(b.vel.z) * dt;

    if (!b.inGutter && Math.abs(b.pos.x) > LANE_HALF - BALL_R * 0.55) {
      b.inGutter = true;
      this.gutter = true;
      b.pos.x = Math.sign(b.pos.x) * (LANE_HALF + 0.06);
      b.pos.y = BALL_R - 0.08;
      sfx.noise(0.4, 260, { gain: 0.14, q: 0.6, filter: "lowpass" });
      this.ctx.ui.toast("GUTTER", "", 1100);
    }

    if (!b.inGutter) { this._ballPinCollisions(); }

    if (b.pos.z > PIN_Z + 1.4 || b.vel.length() < 0.35) {
      b.live = false;
      if (this.state === STATE.ROLL) {
        this.state = STATE.SETTLE;
        this.stateAt = performance.now();
      }
    }
  }

  _ballPinCollisions() {
    const b = this.ball;
    for (const pin of this.pins) {
      if (!pin.standing || pin.down) { continue; }
      const dx = pin.pos.x - b.pos.x;
      const dz = pin.pos.y - b.pos.z;
      const d = Math.hypot(dx, dz);
      const rr = BALL_R + PIN_R;
      if (d > rr || d < 1e-6) { continue; }

      const nx = dx / d, nz = dz / d;
      const speed = Math.hypot(b.vel.x, b.vel.z);
      const along = b.vel.x * nx + b.vel.z * nz;
      if (along <= 0) { continue; }

      // the pin takes most of the momentum, the ball barely deflects
      const transfer = clamp(along * 0.92, 0, 14);
      pin.vel.x += nx * transfer + b.vel.x * 0.16;
      pin.vel.y += nz * transfer + b.vel.z * 0.16;
      pin.tiltAxis.set(nx, nz);
      pin.tiltVel += clamp(transfer * 1.5, 1.5, 16);
      pin.spin += (Math.random() - 0.5) * 8;

      b.vel.x -= nx * transfer * 0.055;
      b.vel.z -= nz * transfer * 0.055;
      b.pos.x -= nx * (rr - d);
      b.pos.z -= nz * (rr - d);

      sfx.pinHit(clamp(speed / 9, 0.2, 1));
      this.ctx.net.buzz(0, 24, false);
    }
  }

  _pinPhysics(dt) {
    const live = this.pins.filter(p => p.standing);

    for (const pin of live) {
      if (pin.vel.lengthSq() < 1e-6 && pin.tiltVel === 0 && pin.tilt === 0) { continue; }

      pin.pos.addScaledVector(pin.vel, dt);
      pin.vel.multiplyScalar(1 - 1.15 * dt);
      if (pin.vel.lengthSq() < 0.004) { pin.vel.set(0, 0); }

      if (pin.tiltVel !== 0 || pin.tilt > 0) {
        pin.tilt += pin.tiltVel * dt;
        if (pin.tilt > 0.28) { pin.tiltVel += 6 * dt; }      // past the tipping point
        else { pin.tiltVel -= 3.5 * dt; }                     // otherwise it rights itself
        if (pin.tilt < 0) { pin.tilt = 0; pin.tiltVel = 0; }
        if (pin.tilt >= Math.PI / 2) {
          pin.tilt = Math.PI / 2;
          pin.tiltVel = 0;
          if (!pin.down) {
            pin.down = true;
            pin.vel.multiplyScalar(0.55);
            sfx.pinHit(0.5);
          }
        }
      }
    }

    // pin against pin
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j];
        const dx = b.pos.x - a.pos.x, dz = b.pos.y - a.pos.y;
        const d = Math.hypot(dx, dz);
        const rr = PIN_R * 2;
        if (d > rr || d < 1e-6) { continue; }
        const nx = dx / d, nz = dz / d;
        const overlap = rr - d;
        a.pos.x -= nx * overlap * 0.5; a.pos.y -= nz * overlap * 0.5;
        b.pos.x += nx * overlap * 0.5; b.pos.y += nz * overlap * 0.5;

        const rel = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * nz;
        if (rel >= 0) { continue; }
        const imp = -rel * 0.88;
        a.vel.x -= nx * imp; a.vel.y -= nz * imp;
        b.vel.x += nx * imp; b.vel.y += nz * imp;

        const force = Math.abs(rel);
        if (force > 0.3) {
          if (!a.down) { a.tiltAxis.set(-nx, -nz); a.tiltVel += force * 1.7; }
          if (!b.down) { b.tiltAxis.set(nx, nz); b.tiltVel += force * 1.7; }
          sfx.pinHit(clamp(force / 6, 0.12, 0.8));
        }
      }
    }

    // draw
    for (const pin of this.pins) {
      if (!pin.standing) { continue; }
      const m = pin.mesh;
      const t = pin.tilt;
      m.position.set(pin.pos.x, Math.sin(t) * PIN_H * 0.42, pin.pos.y);
      m.rotation.set(0, 0, 0);
      if (t > 0.001) {
        const ax = new THREE.Vector3(pin.tiltAxis.y, 0, -pin.tiltAxis.x).normalize();
        m.quaternion.setFromAxisAngle(ax, t);
      }
      if (pin.pos.y > PIN_Z + 1.3 || Math.abs(pin.pos.x) > 1.3) {
        m.visible = false;
      }
    }
  }

  _settleCheck() {
    if (this.state !== STATE.SETTLE) { return; }
    const elapsed = performance.now() - this.stateAt;
    const moving = this.pins.some(p =>
      p.standing && (p.vel.lengthSq() > 0.02 || (p.tiltVel !== 0 && p.tilt < Math.PI / 2)));
    if (elapsed < 900 || (moving && elapsed < 4200)) { return; }
    this._endRoll();
  }

  _endRoll() {
    const before = this.pinsBefore === undefined ? 10 : this.pinsBefore;
    const standing = this._standingCount();
    const knocked = before - standing;

    this.rolls.push(knocked);
    this.frameRolls.push(knocked);

    const tenth = this.frame === 10;
    const first = this.frameRolls.length === 1;

    if (knocked === before && before === 10 && first) {
      this.ctx.ui.toast("STRIKE!", "", 1800);
      sfx.crash(1); sfx.cheer(1);
      this.ctx.net.buzz(0, 220);
    } else if (!first && standing === 0) {
      this.ctx.ui.toast("SPARE!", "", 1600);
      sfx.crash(0.7); sfx.cheer(0.7);
      this.ctx.net.buzz(0, 140);
    } else if (knocked > 0) {
      sfx.crash(clamp(knocked / 10, 0.2, 0.8));
      if (knocked >= 6) { sfx.cheer(0.4); }
    }

    this._syncHud();
    setTimeout(() => this._nextRoll(standing, tenth, first), 1500);
  }

  _nextRoll(standing, tenth, first) {
    if (!tenth) {
      const strike = first && standing === 0;
      if (strike || !first) {
        this.frame++;
        this.frameRolls = [];
        this._rackPins(true);
        this.pinsBefore = 10;
      } else {
        this._clearFallen();
        this.pinsBefore = standing;
      }
    } else {
      const rolls = this.frameRolls;
      const done =
        (rolls.length === 2 && rolls[0] + rolls[1] < 10 && rolls[0] !== 10)
        || rolls.length === 3;
      if (done) {
        this.state = STATE.DONE;
        const { total } = this._computeScore();
        this.ctx.ui.toast("FINAL SCORE", String(total), 8000);
        sfx.cheer(clamp(total / 200, 0.3, 1));
        return;
      }
      if (standing === 0) {
        this._rackPins(true);
        this.pinsBefore = 10;
      } else {
        this._clearFallen();
        this.pinsBefore = standing;
      }
    }

    if (this.frame > 10) {
      this.state = STATE.DONE;
      return;
    }
    this._resetBall();
    this.windPeak = 0;
    this.windYaw = 0;
    this.state = STATE.AIM;
    this._syncHud();
  }

  _clearFallen() {
    for (const pin of this.pins) {
      if (pin.down) {
        pin.standing = false;
        pin.mesh.visible = false;
      }
    }
  }

  _animate(dt, time) {
    this.ballMesh.position.copy(this.ball.pos);
    this.ballMesh.visible = true;

    // roll the ball visually
    const v = this.ball.vel;
    if (this.ball.live) {
      this.ballMesh.rotateOnWorldAxis(
        new THREE.Vector3(v.z, 0, -v.x).normalize(),
        (Math.hypot(v.x, v.z) * dt) / BALL_R);
      this.ballMesh.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), this.ball.spin * 3 * dt);
    }

    idlePose(this.bowler, time);
    this.bowler.position.x = damp(this.bowler.position.x, this.startX, 6, dt);

    const arms = this.bowler.userData.arms;
    if (this.state === STATE.WINDUP) {
      const c = this.ctx.seat(0);
      const lift = clamp((c ? c.speed : 0) / 20, 0, 1);
      arms.right.shoulder.rotation.x = damp(arms.right.shoulder.rotation.x, -0.4 - lift * 2.2, 9, dt);
    } else if (this.armAnim < 1) {
      this.armAnim = Math.min(1, this.armAnim + dt / 0.35);
      arms.right.shoulder.rotation.x = lerp(-2.4, 0.9, this.armAnim);
    } else {
      arms.right.shoulder.rotation.x = damp(arms.right.shoulder.rotation.x, -0.2, 5, dt);
    }

    // aim guide only while lining up
    const aiming = this.state === STATE.AIM || this.state === STATE.WINDUP;
    this.guide.visible = aiming;
    if (aiming) {
      this.guide.position.set(this.startX + Math.sin(this.aimAngle) * 3.5, 0.006, 3.2);
      this.guide.rotation.z = -this.aimAngle;
    }
  }

  _camera(dt) {
    let ty, tz, lookZ;
    if (this.state === STATE.ROLL || this.state === STATE.SETTLE) {
      const follow = clamp(this.ball.pos.z - 4.5, -3.6, PIN_Z - 5.5);
      tz = follow; ty = 1.5; lookZ = PIN_Z + 0.3;
    } else {
      tz = -3.6; ty = 1.75; lookZ = 9;
    }
    this.camera.position.z = damp(this.camera.position.z, tz, 2.4, dt);
    this.camera.position.y = damp(this.camera.position.y, ty, 3, dt);
    this.camera.position.x = damp(this.camera.position.x, this.startX * 0.45, 3, dt);
    this.camera.lookAt(this.startX * 0.2, 0.45, lookZ);
  }
}
