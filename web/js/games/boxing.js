/*
 * Boxing.
 *
 * Throw the phone forward to punch. Tilt as you throw to pick the hand and
 * the shot: flat is a straight, a hard wrist turn is a hook, a big upward
 * chop is an uppercut. Hold the button to raise your guard, and tilt hard
 * without punching to slip a shot.
 *
 * With one player the red corner is driven by the state machine below, which
 * telegraphs most punches so they can be countered. With two, the second phone
 * takes that corner over and the whole fight becomes symmetric - which is why
 * the punch resolution is written in terms of "attacker" and "defender"
 * rather than "you" and "them".
 */

import * as THREE from "../../lib/three.module.js";
import { makeAthlete, addLights, skyDome, idlePose, renderSplit, clamp, damp, lerp }
  from "../arena.js";
import { sfx } from "../audio.js";

const RING = 3.1;              // half-width of the canvas
const PLAYER_Z = -0.85;
const OPP_Z = 0.85;
const ROUND_TIME = 60;
const MAX_ROUNDS = 3;

const PUNCH_COOLDOWN = 420;    // ms; roughly the fastest a real arm swing repeats
const GUARD_SOAK = 0.16;       // fraction of damage a raised guard lets through
const DODGE_TILT = 0.6;        // how far to lean to slip a punch

const OPP = { IDLE: "idle", WIND: "wind", STRIKE: "strike", RECOVER: "recover",
              BLOCK: "block", STUN: "stun", DOWN: "down" };

export class BoxingGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Boxing";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(56, 16 / 9, 0.05, 300);
    this.shake = 0;
    this._build();
  }

  // ------------------------------------------------------------ scenery

  _build() {
    const scene = this.scene;
    scene.add(skyDome(0x0a0e1c, 0x1b2340));
    scene.fog = new THREE.Fog(0x10162a, 12, 40);
    addLights(scene, { sky: 0xaebfe8, ground: 0x2a2438, ambient: 0.5, sun: 1.0, shadowRange: 8 });

    for (const off of [[-3, 3], [3, 3], [-3, -3], [3, -3]]) {
      const lamp = new THREE.PointLight(0xfff0d0, 14, 18, 2);
      lamp.position.set(off[0], 5.4, off[1]);
      scene.add(lamp);
    }

    // canvas
    const canvasMat = new THREE.MeshStandardMaterial({ color: 0x2f5fa8, roughness: 0.92 });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(RING * 2 + 0.6, 0.3, RING * 2 + 0.6), canvasMat);
    floor.position.y = -0.15;
    floor.receiveShadow = true;
    scene.add(floor);

    const apron = new THREE.Mesh(
      new THREE.BoxGeometry(RING * 2 + 1.6, 0.6, RING * 2 + 1.6),
      new THREE.MeshStandardMaterial({ color: 0x1d2740, roughness: 0.95 })
    );
    apron.position.y = -0.62;
    scene.add(apron);

    // posts and ropes
    const postMat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.5 });
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.7 });
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const c of corners) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 1.55, 10), postMat);
      post.position.set(c[0] * RING, 0.78, c[1] * RING);
      post.castShadow = true;
      scene.add(post);
    }
    for (let i = 0; i < 3; i++) {
      const y = 0.42 + i * 0.42;
      for (let k = 0; k < 4; k++) {
        const a = corners[k], b = corners[(k + 1) % 4];
        const ax = a[0] * RING, az = a[1] * RING;
        const bx = b[0] * RING, bz = b[1] * RING;
        const len = Math.hypot(bx - ax, bz - az);
        const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, len, 6), ropeMat);
        rope.position.set((ax + bx) / 2, y, (az + bz) / 2);
        rope.rotation.z = Math.PI / 2;
        rope.rotation.y = -Math.atan2(bz - az, bx - ax);
        scene.add(rope);
      }
    }

    this._crowd();

    // fighters
    this.player = makeAthlete(0x3f7fe8, { pants: 0x1d2740 });
    this.player.position.set(0, 0, PLAYER_Z);
    this.player.rotation.y = 0;                  // facing +z, toward the opponent
    scene.add(this.player);
    this.playerGloves = this._gloves(this.player, 0x2f6fe0);

    this.opp = makeAthlete(0xd0402f, { pants: 0x3a1414, hair: 0x1a1a1f, skin: 0xd9a377 });
    this.opp.position.set(0, 0, OPP_Z);
    this.opp.rotation.y = Math.PI;
    scene.add(this.opp);
    this.oppGloves = this._gloves(this.opp, 0xd0402f);

    this.camera.position.set(0, 1.95, PLAYER_Z - 1.85);
    this.camera.lookAt(0, 1.35, OPP_Z);

    // the red corner's own view, for when a second player takes it over
    this.camera2 = new THREE.PerspectiveCamera(56, 16 / 9, 0.05, 300);
    this.camera2.position.set(0, 1.95, OPP_Z + 1.85);
    this.camera2.lookAt(0, 1.35, PLAYER_Z);
    this.cameras = [this.camera];
  }

  _gloves(athlete, color) {
    const mat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.42 });
    const out = {};
    for (const key of ["left", "right"]) {
      const glove = new THREE.Mesh(new THREE.SphereGeometry(0.145, 16, 12), mat);
      glove.scale.set(1, 0.95, 1.2);
      glove.castShadow = true;
      athlete.userData.arms[key].hand.add(glove);
      out[key] = glove;
    }
    return out;
  }

  _crowd() {
    const count = 320;
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.4, 0.62, 0.4),
      new THREE.MeshStandardMaterial({ roughness: 0.95 }), count);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let i = 0;
    for (let ring = 0; ring < 5 && i < count; ring++) {
      const r = 6 + ring * 1.15;
      const n = Math.floor(18 + ring * 7);
      for (let k = 0; k < n && i < count; k++) {
        const a = (k / n) * Math.PI * 2 + ring * 0.2;
        dummy.position.set(Math.cos(a) * r, -0.9 + ring * 0.32, Math.sin(a) * r);
        dummy.rotation.y = -a + Math.PI / 2;
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        color.setHSL(Math.random(), 0.3 + Math.random() * 0.3, 0.18 + Math.random() * 0.22);
        mesh.setColorAt(i, color);
        i++;
      }
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    this.twoPlayer = this.ctx.humanCount() >= 2;
    this.cameras = this.twoPlayer ? [this.camera, this.camera2] : [this.camera];

    this.health = [100, 100];
    this.round = 1;
    this.timeLeft = ROUND_TIME;
    this.over = false;
    this.betweenRounds = 0;

    this.guard = [false, false];
    this.dodge = [0, 0];
    this.nextHand = ["right", "right"];
    this.lastPunchAt = [0, 0];
    this.flinch = [0, 0];
    this.combo = [0, 0];
    this.lastHitAt = [0, 0];
    this.anim = [
      { t: 1, hand: "right", kind: "straight" },
      { t: 1, hand: "right", kind: "straight" },
    ];

    // clear any knockdown left over from the previous fight
    this.downed = undefined;
    this.player.rotation.x = 0;
    this.player.position.set(0, 0, PLAYER_Z);
    this.opp.rotation.x = 0;
    this.opp.position.set(0, 0, OPP_Z);

    this.opp_state = OPP.IDLE;
    this.opp_at = performance.now();
    this.opp_hand = "right";
    this.oppGuardHits = 0;
    this.oppHitStreak = 0;
    this.oppCommitted = false;
    this.oppNextAttack = performance.now() + 1400;

    this._brief();
    this.ctx.ui.toast("ROUND 1",
      this.twoPlayer ? "Player 1 left, player 2 right" : "Watch for the wind-up", 2000);
    sfx.bell();
    this._syncHud();
  }

  exit() { }

  _brief() {
    const hint = "Punch the phone forward. Tilt as you punch to pick the hand. "
      + "Hold the button to guard, tilt hard to dodge.";
    const p1 = this.ctx.seat(0);
    if (p1) {
      this.ctx.net.mode(p1.pid, this.twoPlayer ? "Boxing - Blue corner" : "Boxing",
        hint, "GUARD", "Hold to keep your guard up");
    }
    if (this.twoPlayer) {
      const p2 = this.ctx.seat(1);
      if (p2) {
        this.ctx.net.mode(p2.pid, "Boxing - Red corner",
          hint, "GUARD", "Hold to keep your guard up");
      }
    }
  }

  /** Fighter index a controller drives: 0 blue, 1 red, or -1 for neither. */
  _sideOf(pid) {
    const seat = this.ctx.seatOf(pid);
    if (this.twoPlayer && seat === 1) { return 1; }
    if (seat === 0 || seat === -1) { return 0; }
    return -1;
  }

  _aiControls(side) {
    return side === 1 && !this.twoPlayer;
  }

  // ------------------------------------------------------------ input

  onSwing(swing) {
    if (this.over || this.betweenRounds > 0) { return; }
    if (swing.power < 0.16) { return; }
    const att = this._sideOf(swing.pid);
    if (att < 0 || this._aiControls(att)) { return; }

    const now = performance.now();
    if (now - this.lastPunchAt[att] < PUNCH_COOLDOWN) { return; }
    this.lastPunchAt[att] = now;

    let hand;
    if (Math.abs(swing.aim) > 0.28) {
      hand = swing.aim < 0 ? "left" : "right";
    } else {
      hand = this.nextHand[att];
      this.nextHand[att] = hand === "right" ? "left" : "right";
    }

    let kind = "straight";
    if (swing.pitchRate > 190 && swing.lean < -0.2) { kind = "uppercut"; }
    else if (Math.abs(swing.yaw) > 165) { kind = "hook"; }

    this.anim[att] = { t: 0, hand: hand, kind: kind };
    sfx.whoosh();

    const base = { straight: 3.4, hook: 4.5, uppercut: 6.0 }[kind];
    this._resolvePunch(att, base * (0.45 + swing.power * 0.75), kind, swing.pid);
  }

  onButton(down, pid) {
    const side = this._sideOf(pid);
    if (side < 0 || this._aiControls(side)) { return; }
    this.guard[side] = down;
  }

  // ------------------------------------------------------------ damage

  _isCommitted(side) {
    return this.anim[side].t < 0.8;      // cannot cover up mid-punch
  }

  _resolvePunch(att, damage, kind, pid) {
    const def = 1 - att;

    // --- a computer-run defender uses its state machine ------------------
    if (this._aiControls(def)) {
      const s = this.opp_state;
      if (s === OPP.DOWN) { return; }

      if (s === OPP.BLOCK) {
        this.oppGuardHits++;
        sfx.block();
        this.ctx.net.buzz(pid, 15, false);
        this.health[def] = Math.max(1, this.health[def] - damage * 0.12);
        if (this.oppGuardHits >= 5) {
          this.oppGuardHits = 0;
          this._setOpp(OPP.STUN, 1500);
          this.ctx.ui.toast("GUARD BROKEN", "Hit them now!", 1200);
          sfx.crash(0.6);
        }
        this._syncHud();
        return;
      }

      const counter = s === OPP.WIND || s === OPP.STRIKE;
      const stunned = s === OPP.STUN;
      this._land(att, def, damage * (counter ? 1.3 : stunned ? 1.9 : 1), kind, pid, counter);

      if (counter) {
        if (!this.oppCommitted) { this._setOpp(OPP.STUN, 900); }
      } else if (!stunned && this.opp_state !== OPP.STUN) {
        this.oppHitStreak++;
        if (this.oppHitStreak >= 3) {
          this.oppHitStreak = 0;
          this.oppGuardHits = 0;
          this._setOpp(OPP.BLOCK, 700 + Math.random() * 500);
        } else {
          this._setOpp(OPP.RECOVER, 380);
        }
      }
      return;
    }

    // --- a human defender: their own guard and lean decide ---------------
    if (Math.abs(this.dodge[def]) > DODGE_TILT) {
      this.ctx.ui.toast(this.twoPlayer ? "SLIPPED" : "DODGED", "", 700);
      sfx.whoosh();
      this.combo[att] = 0;
      return;
    }
    if (this.guard[def] && !this._isCommitted(def)) {
      this.health[def] = Math.max(1, this.health[def] - damage * GUARD_SOAK);
      sfx.block();
      this.ctx.net.buzz(pid, 15, false);
      this._syncHud();
      return;
    }
    // caught mid-punch counts as a counter, same as catching the AI winding up
    const counter = this._isCommitted(def);
    this._land(att, def, damage * (counter ? 1.3 : 1), kind, pid, counter);
  }

  /** Damage that actually gets through, plus all the trimmings. */
  _land(att, def, dealt, kind, pid, counter) {
    this.health[def] = Math.max(0, this.health[def] - dealt);
    this.flinch[def] = 1;
    this.combo[att]++;
    this.combo[def] = 0;
    this.lastHitAt[att] = performance.now();
    this.shake = 0.16 + dealt / 90;

    sfx.punch(clamp(dealt / 18, 0.3, 1));
    this.ctx.net.buzz(pid, 30 + dealt * 3);
    const victim = this.ctx.seat(def);
    if (victim) { this.ctx.net.buzz(victim.pid, 60 + dealt * 4); }

    const who = this.twoPlayer ? (att === 0 ? "P1 " : "P2 ") : "";
    if (counter) {
      this.ctx.ui.toast(who + "COUNTER!", "", 900);
      sfx.cheer(0.5);
    } else if (kind === "uppercut") {
      this.ctx.ui.toast(who + "UPPERCUT", "", 800);
    } else if (this.combo[att] >= 3) {
      this.ctx.ui.toast(who + this.combo[att] + " HIT COMBO", "", 800);
    }

    if (this.health[def] <= 0) { this._knockout(att); }
    this._syncHud();
  }

  // ------------------------------------------------------------ opponent AI

  _setOpp(state, ms) {
    this.opp_state = state;
    this.opp_at = performance.now() + (ms || 0);
    if (state === OPP.STUN) {
      this.oppNextAttack = Math.max(this.oppNextAttack, this.opp_at + 250);
    }
  }

  _heat() {
    return clamp(0.35 + (this.round - 1) * 0.22 + (1 - this.health[1] / 100) * 0.3, 0, 1);
  }

  /**
   * Two clocks: `opp_at` finishes the move already in flight, `oppNextAttack`
   * decides when the next one starts. Keeping them apart is what stops the
   * fight being won by mashing - only a stun, which has to be earned with a
   * counter or a guard break, can delay the attack clock.
   */
  _oppBrain(dt) {
    if (this.twoPlayer) { return; }
    if (this.over || this.betweenRounds > 0) { return; }
    const now = performance.now();
    const heat = this._heat();

    if (this.opp_state === OPP.WIND) {
      if (now >= this.opp_at) {
        this._setOpp(OPP.STRIKE, 150);
        this.anim[1] = { t: 0, hand: this.opp_hand, kind: "straight" };
        sfx.whoosh();
        this._oppLand();
      }
      return;
    }
    if (this.opp_state === OPP.STRIKE) {
      if (now >= this.opp_at) { this._setOpp(OPP.RECOVER, lerp(620, 260, heat)); }
      return;
    }
    if (this.opp_state === OPP.STUN) {
      if (now >= this.opp_at) {
        this.opp_state = OPP.IDLE;
        this.opp_at = now;
        this.oppGuardHits = 0;
      }
      return;
    }

    if (now >= this.oppNextAttack) {
      this.opp_hand = Math.random() < 0.5 ? "left" : "right";
      const jab = Math.random() < 0.34;
      this.oppCommitted = jab;
      this._setOpp(OPP.WIND, jab ? lerp(210, 140, heat) : lerp(560, 300, heat));
      this.oppNextAttack = now + lerp(1900, 780, heat) + Math.random() * 550;
      sfx.tone(jab ? 330 : 240, 0.07, { type: "square", gain: 0.06 });
      return;
    }

    if (now >= this.opp_at) {
      if (this.opp_state === OPP.BLOCK) {
        this.opp_state = OPP.IDLE;
        this.opp_at = now;
        this.oppGuardHits = 0;
      } else if (Math.random() < 0.03) {
        this._setOpp(OPP.BLOCK, 420 + Math.random() * 620);
      } else {
        this.opp_state = OPP.IDLE;
        this.opp_at = now + 120;
      }
    }
  }

  _oppLand() {
    const damage = 6 + Math.random() * 7 + (this.round - 1) * 1.5;

    if (Math.abs(this.dodge[0]) > DODGE_TILT) {
      this.ctx.ui.toast("DODGED", "", 700);
      sfx.whoosh();
      this.combo[0] = 0;
      return;
    }
    if (this.guard[0] && !this._isCommitted(0)) {
      this.health[0] = Math.max(1, this.health[0] - damage * GUARD_SOAK);
      sfx.block();
      this.ctx.net.buzz(0, 25, false);
      this.shake = 0.08;
    } else {
      this.health[0] = Math.max(0, this.health[0] - damage);
      this.flinch[0] = 1;
      this.combo[0] = 0;
      this.oppHitStreak = 0;
      sfx.punch(clamp(damage / 14, 0.3, 1));
      this.ctx.net.buzz(0, 90 + damage * 4);
      this.shake = 0.22 + damage / 60;
      if (this.health[0] <= 0) { this._knockout(1); }
    }
    this._syncHud();
  }

  // ------------------------------------------------------------ match flow

  _name(side) {
    if (this.twoPlayer) { return side === 0 ? "PLAYER 1" : "PLAYER 2"; }
    return side === 0 ? "YOU" : "THE OPPONENT";
  }

  _knockout(winner) {
    this.over = true;
    if (winner === 0 && !this.twoPlayer) {
      this._setOpp(OPP.DOWN, 0);
      this.ctx.ui.toast("KNOCKOUT!", "You win by KO", 8000);
      sfx.cheer(1);
    } else if (winner === 1 && !this.twoPlayer) {
      this.ctx.ui.toast("YOU ARE DOWN", "Knocked out in round " + this.round, 8000);
      sfx.cheer(0.2);
    } else {
      this.downed = 1 - winner;
      this.ctx.ui.toast("KNOCKOUT!", this._name(winner) + " wins by KO", 8000);
      sfx.cheer(1);
    }
    sfx.bell();
    this.ctx.net.buzz(0, 400);
  }

  _endRound() {
    if (this.round >= MAX_ROUNDS) {
      this.over = true;
      const [a, b] = this.health;
      const title = a === b ? "DRAW"
        : this.twoPlayer ? this._name(a > b ? 0 : 1) + " WINS"
          : (a > b ? "YOU WIN" : "YOU LOSE");
      this.ctx.ui.toast(title, "on points after " + MAX_ROUNDS + " rounds", 8000);
      sfx.bell();
      sfx.cheer(a > b ? 1 : 0.25);
      return;
    }
    this.round++;
    this.timeLeft = ROUND_TIME;
    this.betweenRounds = 3.2;
    this.health[0] = Math.min(100, this.health[0] + 18);
    this.health[1] = Math.min(100, this.health[1] + (this.twoPlayer ? 18 : 14));
    this._setOpp(OPP.IDLE, 1200);
    this.oppNextAttack = performance.now() + 4200;
    sfx.bell();
    this.ctx.ui.toast("ROUND " + this.round, "", 2200);
    this._syncHud();
  }

  _syncHud() {
    const bar = (v, cls) =>
      '<div class="bar"><i class="' + cls + '" style="width:'
      + clamp(v, 0, 100).toFixed(0) + '%"></i></div>';
    const left = this.twoPlayer ? "P1" : "YOU";
    const right = this.twoPlayer ? "P2" : "CPU";
    this.ctx.ui.hud(
      '<div class="hudRow boxRow">'
      + '<span class="tag blue">' + left + '</span>' + bar(this.health[0], "blue")
      + '<span class="round">R' + this.round + '</span>'
      + bar(this.health[1], "red") + '<span class="tag red">' + right + '</span>'
      + '</div>'
      + '<div class="hudSub">' + Math.ceil(Math.max(0, this.timeLeft)) + 's</div>'
    );
  }

  // ------------------------------------------------------------ update

  update(dt, time) {
    for (let i = 0; i < 2; i++) {
      if (this._aiControls(i)) { this.dodge[i] = 0; continue; }
      const c = this.ctx.seat(i);
      this.dodge[i] = c ? c.aim : 0;
    }

    if (!this.over) {
      if (this.betweenRounds > 0) {
        this.betweenRounds -= dt;
      } else {
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) { this._endRound(); }
        if (Math.ceil(this.timeLeft) !== this._lastShownTime) {
          this._lastShownTime = Math.ceil(this.timeLeft);
          this._syncHud();
        }
      }
    }

    for (let i = 0; i < 2; i++) {
      if (performance.now() - this.lastHitAt[i] > 1600) { this.combo[i] = 0; }
    }

    this._oppBrain(dt);
    this._animate(dt, time);
    this._camera(dt);

    this.ctx.ui.prompt(this.over || this.twoPlayer ? "" :
      this.opp_state === OPP.STUN ? "They are open - hit them!"
        : this.opp_state === OPP.WIND ? "Incoming - guard or dodge!" : "");
  }

  _animate(dt, time) {
    idlePose(this.player, time);
    idlePose(this.opp, time * 1.07 + 2.1);

    for (let i = 0; i < 2; i++) { this.flinch[i] = Math.max(0, this.flinch[i] - dt * 4); }

    const guardPose = (arms, amount) => {
      for (const key of ["left", "right"]) {
        const a = arms[key];
        a.shoulder.rotation.x = damp(a.shoulder.rotation.x, lerp(-0.3, -1.15, amount), 12, dt);
        a.shoulder.rotation.z = damp(a.shoulder.rotation.z,
          (key === "left" ? 1 : -1) * lerp(0.2, 0.45, amount), 12, dt);
        a.elbow.rotation.x = damp(a.elbow.rotation.x, lerp(-0.9, -1.9, amount), 12, dt);
      }
    };

    const punchPose = (fighter, arms, anim, mirror) => {
      if (anim.t >= 1) {
        fighter.userData.torso.rotation.y =
          damp(fighter.userData.torso.rotation.y, 0, 8, dt);
        return;
      }
      anim.t = Math.min(1, anim.t + dt / 0.3);
      const reach = Math.sin(Math.min(1, anim.t * 1.35) * Math.PI);
      const arm = arms[anim.hand];
      arm.shoulder.rotation.x = lerp(-0.9, anim.kind === "uppercut" ? -2.4 : -1.62, reach);
      arm.elbow.rotation.x = lerp(-1.6, -0.1, reach);
      arm.shoulder.rotation.z = (anim.hand === "left" ? 1 : -1)
        * lerp(0.35, anim.kind === "hook" ? 0.95 : 0.08, reach);
      fighter.userData.torso.rotation.y =
        (anim.hand === "left" ? 1 : -1) * reach * 0.3 * mirror;
    };

    // --- blue corner -----------------------------------------------------
    const pArms = this.player.userData.arms;
    guardPose(pArms, this.guard[0] ? 1 : 0.55);
    punchPose(this.player, pArms, this.anim[0], 1);
    this.player.userData.torso.rotation.z =
      damp(this.player.userData.torso.rotation.z, -this.dodge[0] * 0.4, 8, dt);
    this.player.position.x = damp(this.player.position.x, this.dodge[0] * 0.42, 6, dt);
    this.player.position.z = damp(this.player.position.z, PLAYER_Z - this.flinch[0] * 0.22, 9, dt);

    // --- red corner ------------------------------------------------------
    const oArms = this.opp.userData.arms;
    if (this.twoPlayer) {
      guardPose(oArms, this.guard[1] ? 1 : 0.55);
      punchPose(this.opp, oArms, this.anim[1], -1);
      this.opp.userData.torso.rotation.z =
        damp(this.opp.userData.torso.rotation.z, this.dodge[1] * 0.4, 8, dt);
      // their screen-right is world -x, so the lean mirrors
      this.opp.position.x = damp(this.opp.position.x, -this.dodge[1] * 0.42, 6, dt);
      this.opp.userData.neck.rotation.z = 0;
      this.opp.userData.torso.rotation.x =
        damp(this.opp.userData.torso.rotation.x, 0, 8, dt);
    } else {
      const s = this.opp_state;
      guardPose(oArms, s === OPP.BLOCK ? 1 : s === OPP.STUN ? 0.05 : 0.55);
      if (s === OPP.WIND) {
        const arm = oArms[this.opp_hand];
        arm.shoulder.rotation.x = damp(arm.shoulder.rotation.x, -0.35, 10, dt);
        this.opp.userData.torso.rotation.y =
          damp(this.opp.userData.torso.rotation.y,
            (this.opp_hand === "left" ? -1 : 1) * 0.35, 9, dt);
      } else {
        this.opp.userData.torso.rotation.y =
          damp(this.opp.userData.torso.rotation.y, 0, 8, dt);
      }
      punchPose(this.opp, oArms, this.anim[1], -1);

      if (s === OPP.STUN) {
        this.opp.userData.neck.rotation.z = Math.sin(time * 9) * 0.16;
        this.opp.userData.torso.rotation.x = 0.16;
      } else if (s === OPP.DOWN) {
        this.opp.rotation.x = damp(this.opp.rotation.x, -1.5, 4, dt);
        this.opp.position.y = damp(this.opp.position.y, 0.28, 4, dt);
      } else {
        this.opp.userData.neck.rotation.z = 0;
        this.opp.userData.torso.rotation.x =
          damp(this.opp.userData.torso.rotation.x, 0, 8, dt);
      }
      this.opp.position.x = damp(this.opp.position.x, Math.sin(time * 0.7) * 0.3, 3, dt);
    }

    this.opp.position.z = damp(this.opp.position.z, OPP_Z + this.flinch[1] * 0.26, 9, dt);

    // whoever got knocked out in a two-player bout goes down
    if (this.twoPlayer && this.downed !== undefined) {
      const loser = this.downed === 0 ? this.player : this.opp;
      loser.rotation.x = damp(loser.rotation.x, this.downed === 0 ? 1.5 : -1.5, 4, dt);
      loser.position.y = damp(loser.position.y, 0.28, 4, dt);
    }
  }

  _camera(dt) {
    if (this.shake > 0.001) { this.shake *= Math.exp(-7 * dt); }
    const shake = this.shake > 0.001 ? this.shake : 0;

    const place = (cam, self, foe, homeZ) => {
      cam.position.x = damp(cam.position.x, self.position.x * 0.5, 5, dt);
      cam.position.y = damp(cam.position.y, 1.95, 4, dt);
      cam.position.z = damp(cam.position.z, homeZ, 4, dt);
      if (shake) {
        cam.position.x += (Math.random() - 0.5) * shake;
        cam.position.y += (Math.random() - 0.5) * shake;
      }
      cam.lookAt(foe.position.x * 0.4, 1.35, foe.position.z);
    };

    place(this.camera, this.player, this.opp, PLAYER_Z - 1.85);
    if (this.twoPlayer) { place(this.camera2, this.opp, this.player, OPP_Z + 1.85); }
  }

  render(renderer) {
    renderSplit(renderer, this.scene, this.cameras);
  }
}
