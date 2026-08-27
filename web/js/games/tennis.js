/*
 * Tennis.
 *
 * Your athlete slides to intercept on its own, exactly like the game this is
 * modelled on - all you supply is the swing. Timing decides whether the ball
 * comes off clean, tilt and wrist direction steer it, swing speed sets depth.
 */

import * as THREE from "../../lib/three.module.js";
import { makeAthlete, addLights, skyDome, idlePose, blobShadow, renderSplit,
         clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";

const HALF_W = 4.115;        // singles court half width
const HALF_L = 11.885;       // baseline distance from the net
const NET_H = 0.95;
const BALL_R = 0.055;        // a touch bigger than life so it reads on screen
const G = 9.81;

const PLAYER_LINE = 10.4;    // where your athlete stands to strike
const OPP_LINE = -10.4;
const SERVICE_LINE = 6.4;

const STATE = { SERVE: "serve", TOSS: "toss", RALLY: "rally", DEAD: "dead", OVER: "over" };
const POINTS = ["0", "15", "30", "40"];

export class TennisGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Tennis";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 500);
    this.shake = 0;
    this._build();
  }

  // ------------------------------------------------------------ scenery

  _build() {
    const scene = this.scene;
    scene.add(skyDome(0x4a86d8, 0xbfe0ff));
    scene.fog = new THREE.Fog(0x9fc8ee, 60, 190);
    addLights(scene, { shadowRange: 20 });

    // surrounding apron
    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(46, 62),
      new THREE.MeshStandardMaterial({ color: 0x2f6b4f, roughness: 0.95 })
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.02;
    apron.receiveShadow = true;
    scene.add(apron);

    // court surface
    const court = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_W * 2 + 4.4, HALF_L * 2 + 5.2),
      new THREE.MeshStandardMaterial({ color: 0x2f6fae, roughness: 0.9 })
    );
    court.rotation.x = -Math.PI / 2;
    court.receiveShadow = true;
    scene.add(court);

    const inner = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_W * 2, HALF_L * 2),
      new THREE.MeshStandardMaterial({ color: 0x3f86c9, roughness: 0.88 })
    );
    inner.rotation.x = -Math.PI / 2;
    inner.position.y = 0.005;
    inner.receiveShadow = true;
    scene.add(inner);

    this._lines();
    this._net();
    this._stands();

    // ball
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 18, 14),
      new THREE.MeshStandardMaterial({ color: 0xdcff4a, roughness: 0.65 })
    );
    this.ball.castShadow = true;
    scene.add(this.ball);

    this.ballShadow = blobShadow(0.34);
    scene.add(this.ballShadow);

    // athletes
    this.player = makeAthlete(0x2f6fe0, { pants: 0xf4f4f4 });
    this.player.position.set(0, 0, PLAYER_LINE);
    this.player.rotation.y = Math.PI;          // facing the net (-z)
    this.scene.add(this.player);
    this.playerRacket = this._racket(0x2f6fe0);
    this.player.userData.arms.right.hand.add(this.playerRacket);

    this.opp = makeAthlete(0xe2574a, { pants: 0x22304e, hair: 0x1d1d24 });
    this.opp.position.set(0, 0, OPP_LINE);
    this.scene.add(this.opp);
    this.oppRacket = this._racket(0xe2574a);
    this.opp.userData.arms.right.hand.add(this.oppRacket);

    this.camera.position.set(0, 5.4, PLAYER_LINE + 6.6);
    this.camera.lookAt(0, 1.0, 0);

    // player two watches from behind the far baseline, looking back up court
    this.camera2 = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 500);
    this.camera2.position.set(0, 5.4, OPP_LINE - 6.6);
    this.camera2.lookAt(0, 1.0, 0);
    this.cameras = [this.camera];
  }

  _lines() {
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    const add = (w, l, x, z) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), white);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.012, z);
      this.scene.add(m);
    };
    const T = 0.07;
    add(HALF_W * 2 + T, T, 0, HALF_L);        // baselines
    add(HALF_W * 2 + T, T, 0, -HALF_L);
    add(T, HALF_L * 2, -HALF_W, 0);           // sidelines
    add(T, HALF_L * 2, HALF_W, 0);
    add(HALF_W * 2, T, 0, SERVICE_LINE);      // service lines
    add(HALF_W * 2, T, 0, -SERVICE_LINE);
    add(T, SERVICE_LINE * 2, 0, 0);           // centre service line
  }

  _net() {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_W * 2 + 1.5, NET_H),
      new THREE.MeshStandardMaterial({
        color: 0x1b1f2a, roughness: 0.9,
        transparent: true, opacity: 0.82, side: THREE.DoubleSide,
      })
    );
    mesh.position.y = NET_H / 2;
    group.add(mesh);

    const band = new THREE.Mesh(
      new THREE.BoxGeometry(HALF_W * 2 + 1.5, 0.075, 0.03),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 })
    );
    band.position.y = NET_H;
    group.add(band);

    const postMat = new THREE.MeshStandardMaterial({ color: 0x3a4152, roughness: 0.5 });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, NET_H + 0.16, 10), postMat);
      post.position.set(side * (HALF_W + 0.75), (NET_H + 0.16) / 2, 0);
      post.castShadow = true;
      group.add(post);
    }
    this.scene.add(group);
  }

  _stands() {
    // low wall plus an instanced crowd - cheap, but it makes the court feel real
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x1f4a6d, roughness: 0.9 });
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.1, 58), wallMat);
      wall.position.set(side * 15, 0.55, 0);
      wall.receiveShadow = true;
      this.scene.add(wall);
    }
    const back = new THREE.Mesh(new THREE.BoxGeometry(31, 1.1, 0.4), wallMat);
    back.position.set(0, 0.55, -21);
    this.scene.add(back);

    const count = 460;
    const geo = new THREE.BoxGeometry(0.42, 0.55, 0.42);
    const mesh = new THREE.InstancedMesh(
      geo, new THREE.MeshStandardMaterial({ roughness: 0.95 }), count);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let i = 0;
    const place = (x, z) => {
      if (i >= count) { return; }
      dummy.position.set(x, 1.35 + Math.random() * 0.1, z);
      dummy.rotation.y = Math.random() * 0.6 - 0.3;
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      color.setHSL(Math.random(), 0.45 + Math.random() * 0.3, 0.45 + Math.random() * 0.2);
      mesh.setColorAt(i, color);
      i++;
    };
    for (let row = 0; row < 4; row++) {
      for (let z = -20; z < 20; z += 0.9) {
        place(-15.6 - row * 0.85, z + Math.random() * 0.3);
        place(15.6 + row * 0.85, z + Math.random() * 0.3);
      }
    }
    for (let row = 0; row < 3; row++) {
      for (let x = -15; x < 15; x += 0.9) {
        place(x + Math.random() * 0.3, -21.6 - row * 0.85);
      }
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    this.crowd = mesh;
    this.scene.add(mesh);
  }

  _racket(color) {
    const g = new THREE.Group();
    const frame = new THREE.Mesh(
      new THREE.TorusGeometry(0.17, 0.022, 8, 22),
      new THREE.MeshStandardMaterial({ color: color, roughness: 0.45, metalness: 0.25 })
    );
    frame.position.y = -0.36;
    frame.rotation.x = Math.PI / 2;
    frame.castShadow = true;
    g.add(frame);

    const strings = new THREE.Mesh(
      new THREE.CircleGeometry(0.155, 18),
      new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.8,
        transparent: true, opacity: 0.28, side: THREE.DoubleSide,
      })
    );
    strings.position.y = -0.36;
    strings.rotation.x = Math.PI / 2;
    g.add(strings);

    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.032, 0.2, 8),
      new THREE.MeshStandardMaterial({ color: 0x22242e, roughness: 0.9 })
    );
    handle.position.y = -0.1;
    g.add(handle);
    return g;
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    this.match = {
      pPoints: 0, oPoints: 0,
      pGames: 0, oGames: 0,
      server: "player",
      faults: 0,
    };
    this.state = STATE.SERVE;
    this.stateAt = 0;
    this.rally = 0;
    this.swingAnim = { t: 1, side: 1 };
    this.oppSwingAnim = { t: 1 };
    this.oppTargetX = 0;
    this.playerTargetX = 0;
    this.lastHitBy = null;
    this.bounces = 0;
    this.serveMode = "player";
    this.message = "";
    this.tossAt = 0;
    this.serveShot = null;

    this.twoPlayer = this.ctx.humanCount() >= 2;
    this.cameras = this.twoPlayer ? [this.camera, this.camera2] : [this.camera];

    this._resetBall();
    this._prompt();
    this._syncHud();
    this.ctx.ui.toast("TENNIS",
      this.twoPlayer ? "Player 1 left, player 2 right" : "Swing your phone like a racket",
      1800);
  }

  exit() { }

  _prompt() {
    const hint = "Swing to hit. Tilt left or right as you swing to place the ball.";
    const p1 = this.ctx.seat(0);
    if (p1) {
      this.ctx.net.mode(p1.pid, this.twoPlayer ? "Tennis - Player 1" : "Tennis",
        hint, "SERVE", "Swing to serve when it is your turn");
    }
    if (this.twoPlayer) {
      const p2 = this.ctx.seat(1);
      if (p2) {
        this.ctx.net.mode(p2.pid, "Tennis - Player 2",
          hint, "SERVE", "Swing to serve when it is your turn");
      }
    }
  }

  /** True when a human is responsible for that end of the court. */
  _isHuman(side) {
    return side === "player" || this.twoPlayer;
  }

  // ------------------------------------------------------------ ball

  _resetBall() {
    this.ballPos = new THREE.Vector3(0, 1.0, this.match.server === "player" ? PLAYER_LINE : OPP_LINE);
    this.ballVel = new THREE.Vector3(0, 0, 0);
    this.ballLive = false;
    this.bounces = 0;
    this.lastHitBy = null;
  }

  _serveToss(who) {
    const from = who === "player" ? PLAYER_LINE : OPP_LINE;
    const x = who === "player" ? this.player.position.x : this.opp.position.x;
    this.ballPos.set(x, 1.35, from - (who === "player" ? 0.35 : -0.35));
    this.ballVel.set(0, 5.4, 0);
    this.ballLive = true;
    this.bounces = 0;
    this.lastHitBy = null;
    this.state = STATE.TOSS;
    this.tossAt = performance.now();
    sfx.whoosh();
  }

  /** Send the ball toward a spot on the far side. */
  _launch(targetX, targetZ, power, from) {
    const flight = clamp(1.18 - power * 0.44, 0.55, 1.3);
    const p = this.ballPos;
    const vx = (targetX - p.x) / flight;
    const vz = (targetZ - p.z) / flight;
    let vy = (BALL_R - p.y + 0.5 * G * flight * flight) / flight;

    this.ballVel.set(vx, vy, vz);

    // make sure it actually clears the net
    const tNet = Math.abs(p.z) / Math.abs(vz || 0.001);
    if (tNet > 0 && tNet < flight) {
      const yAtNet = p.y + vy * tNet - 0.5 * G * tNet * tNet;
      const needed = NET_H + 0.22;
      if (yAtNet < needed) {
        vy += (needed - yAtNet) / tNet;
        this.ballVel.y = vy;
      }
    }

    this.ballLive = true;
    this.bounces = 0;
    this.lastHitBy = from;
    this.state = STATE.RALLY;

    // The opponent reads each shot slightly wrong, and harder shots fool it
    // more. Without this it tracks perfectly and rallies never end.
    if (from === "player" && !this.twoPlayer) {
      this.oppAimError = (Math.random() - 0.5) * (1.3 + power * 3.2);
    } else if (this.twoPlayer) {
      this.oppAimError = 0;
    }
  }

  // ------------------------------------------------------------ input

  /** Which end of the court a controller is playing, or null if it has none. */
  _sideOf(pid) {
    const seat = this.ctx.seatOf(pid);
    if (seat === 1 && this.twoPlayer) { return "opp"; }
    if (seat === 0 || seat === -1) { return "player"; }
    return null;
  }

  onSwing(swing) {
    if (this.state === STATE.OVER) { return; }
    const side = this._sideOf(swing.pid);
    if (!side) { return; }
    if (side === "opp" && !this.twoPlayer) { return; }
    this._strike(side, swing);
  }

  /**
   * One swing, from whichever end. Everything mirrors around the net: the far
   * player's screen-right is world -x, and they aim at positive z.
   */
  _strike(side, swing) {
    const near = side === "player";
    const sgn = near ? 1 : -1;               // direction this side hits the ball
    const line = near ? PLAYER_LINE : OPP_LINE;
    const athlete = near ? this.player : this.opp;

    if (this.state === STATE.SERVE && this.match.server === side) {
      this._serveToss(side);
      return;
    }

    if (this.state === STATE.TOSS && this.match.server === side) {
      // strike the toss - height decides whether it is a clean serve
      const h = this.ballPos.y;
      if (h < 1.5) { return; }
      const quality = clamp(1 - Math.abs(h - 2.5) / 1.6, 0.15, 1);
      const power = clamp(0.35 + swing.power * 0.65, 0, 1) * (0.55 + quality * 0.45);
      const dir = clamp(swing.aim * 1.1 + swing.yaw / 260, -1, 1) * sgn;
      const boxSide = (this.match.pPoints + this.match.oPoints) % 2 === 0 ? -1 : 1;
      const targetX = clamp(boxSide * 2.0 * sgn + dir * 1.7, -HALF_W + 0.3, HALF_W - 0.3);
      const targetZ = -sgn * clamp(2.6 + power * 3.4, 2.0, SERVICE_LINE - 0.3);
      this._launch(targetX, targetZ, power, side);
      this._swingFx(side, swing, power);
      this.serveShot = side;
      return;
    }

    if (this.state !== STATE.RALLY) { return; }
    if (this.lastHitBy === side) { return; }              // cannot hit twice
    if (this.ballVel.z * sgn <= 0) { return; }            // ball going away

    const dz = (this.ballPos.z - line) * sgn;
    if (dz < -3.4 || dz > 2.2) {                          // far too early or late
      this._swingFx(side, swing, swing.power * 0.5);
      sfx.whoosh();
      return;
    }
    const dx = Math.abs(this.ballPos.x - athlete.position.x);
    if (dx > 2.0 || this.ballPos.y > 2.6) {
      this._swingFx(side, swing, swing.power * 0.5);
      sfx.whoosh();
      return;
    }

    const timing = clamp(1 - Math.abs(dz + 0.6) / 2.4, 0.1, 1);
    const reach = clamp(1 - dx / 2.0, 0.2, 1);
    const quality = timing * 0.7 + reach * 0.3;

    const power = clamp(0.28 + swing.power * 0.72, 0, 1) * (0.5 + quality * 0.5);
    const dir = clamp(swing.aim * 1.15 + swing.yaw / 240, -1, 1) * sgn;
    const targetX = clamp(dir * HALF_W * 0.88, -HALF_W + 0.25, HALF_W - 0.25);
    const targetZ = -sgn * clamp(2.5 + power * 8.6, 2.0, HALF_L - 0.5);

    this._launch(targetX, targetZ, power, side);
    this._swingFx(side, swing, power);
    this.rally++;
    sfx.racket(power * quality);
    this.ctx.net.buzz(swing.pid, 18 + quality * 30);
    this.shake = 0.12 + power * 0.14;
  }

  _swingFx(side, swing, power) {
    const anim = side === "player" ? this.swingAnim : this.oppSwingAnim;
    anim.t = 0;
    anim.side = swing.yaw >= 0 ? 1 : -1;
    anim.power = power;
  }

  // ------------------------------------------------------------ scoring

  _pointTo(who, why) {
    if (this.state === STATE.OVER) { return; }
    this.state = STATE.DEAD;
    this.stateAt = performance.now();
    this.ballLive = false;

    const m = this.match;
    if (who === "player") { m.pPoints++; } else { m.oPoints++; }

    let gameWon = null;
    if (m.pPoints >= 4 && m.pPoints - m.oPoints >= 2) { gameWon = "player"; }
    if (m.oPoints >= 4 && m.oPoints - m.pPoints >= 2) { gameWon = "opp"; }

    if (gameWon) {
      if (gameWon === "player") { m.pGames++; } else { m.oGames++; }
      m.pPoints = 0; m.oPoints = 0;
      m.server = m.server === "player" ? "opp" : "player";
      const won = gameWon === "player";
      if (m.pGames >= 4 || m.oGames >= 4) {
        this.state = STATE.OVER;
        const p1Won = m.pGames > m.oGames;
        const title = this.twoPlayer
          ? (p1Won ? "PLAYER 1 WINS!" : "PLAYER 2 WINS!")
          : (p1Won ? "YOU WIN!" : "YOU LOSE");
        this.ctx.ui.toast(title,
          m.pGames + " games - " + m.oGames + " games", 6000);
        sfx.cheer(m.pGames > m.oGames ? 1 : 0.3);
        this.ctx.net.buzz(0, 300);
      } else {
        const label = this.twoPlayer
          ? (won ? "GAME - PLAYER 1" : "GAME - PLAYER 2")
          : (won ? "GAME - YOU" : "GAME - OPPONENT");
        this.ctx.ui.toast(label, "Games " + m.pGames + " - " + m.oGames, 2400);
        sfx.cheer(won ? 0.8 : 0.25);
      }
    } else {
      const scorer = this.twoPlayer
        ? (who === "player" ? "PLAYER 1" : "PLAYER 2")
        : (who === "player" ? "POINT" : "OPPONENT");
      this.ctx.ui.toast(scorer, why, 1500);
      sfx.point(who === "player");
      sfx.cheer(who === "player" ? 0.5 : 0.15);
    }
    this.match.faults = 0;
    this._syncHud();
  }

  _fault() {
    this.match.faults++;
    this.ballLive = false;
    this.state = STATE.DEAD;
    this.stateAt = performance.now();
    if (this.match.faults >= 2) {
      this.ctx.ui.toast("DOUBLE FAULT", "", 1500);
      this._pointTo(this.match.server === "player" ? "opp" : "player", "double fault");
    } else {
      this.ctx.ui.toast("FAULT", "One more serve", 1400);
      sfx.point(false);
    }
  }

  _scoreText() {
    const m = this.match;
    if (m.pPoints >= 3 && m.oPoints >= 3) {
      if (m.pPoints === m.oPoints) { return "Deuce"; }
      if (this.twoPlayer) {
        return m.pPoints > m.oPoints ? "Advantage player 1" : "Advantage player 2";
      }
      return m.pPoints > m.oPoints ? "Advantage you" : "Advantage opponent";
    }
    return POINTS[Math.min(m.pPoints, 3)] + " - " + POINTS[Math.min(m.oPoints, 3)];
  }

  _syncHud() {
    const m = this.match;
    const near = this.twoPlayer ? "P1" : "YOU";
    const far = this.twoPlayer ? "P2" : "CPU";
    const serving = this.match.server === "player"
      ? (this.twoPlayer ? "  &middot;  player 1 serves" : "  &middot;  your serve")
      : (this.twoPlayer ? "  &middot;  player 2 serves" : "  &middot;  opponent serves");
    this.ctx.ui.hud(
      '<div class="hudRow"><span class="tag blue">' + near + '</span>'
      + '<span class="big">' + m.pGames + '</span>'
      + '<span class="sep">games</span>'
      + '<span class="big">' + m.oGames + '</span>'
      + '<span class="tag red">' + far + '</span></div>'
      + '<div class="hudSub">' + this._scoreText() + serving + '</div>'
    );
  }

  // ------------------------------------------------------------ update

  update(dt, time) {
    this._physics(dt);
    this._ai(dt);
    this._animate(dt, time);
    this._camera(dt);

    if (this.state === STATE.DEAD && performance.now() - this.stateAt > 1700) {
      if (this.match.pGames >= 4 || this.match.oGames >= 4) {
        this.state = STATE.OVER;
      } else {
        this.state = STATE.SERVE;
        this._resetBall();
        this._syncHud();
      }
    }

    if (this.state === STATE.SERVE) {
      if (this.match.server === "opp" && !this.twoPlayer) {
        if (!this._oppServeAt) { this._oppServeAt = performance.now() + 1100; }
        if (performance.now() > this._oppServeAt) {
          this._oppServeAt = 0;
          this._serveToss("opp");
        }
      } else {
        this.ctx.ui.prompt(this.twoPlayer
          ? (this.match.server === "player" ? "Player 1: swing to serve"
                                            : "Player 2: swing to serve")
          : "Swing to serve");
      }
    } else {
      this.ctx.ui.prompt(
        this.state === STATE.TOSS && this._isHuman(this.match.server)
          ? "Swing now!" : "");
    }

    if (this.state === STATE.TOSS) {
      const owner = this.match.server;
      if (owner === "opp" && !this.twoPlayer
          && this.ballPos.y > 2.3 && this.ballVel.y > 0) {
        this._oppServe();
      }
      // a toss whoever is serving never swings at is a fault
      if (this._isHuman(owner) && this.ballPos.y <= BALL_R + 0.01 && this.ballVel.y < 0) {
        this._fault();
      }
    }
  }

  _physics(dt) {
    if (!this.ballLive) { return; }
    const p = this.ballPos, v = this.ballVel;

    v.y -= G * dt;
    const drag = 1 - 0.42 * dt;
    v.x *= drag; v.z *= drag;

    const prevZ = p.z;
    p.addScaledVector(v, dt);

    // net
    if ((prevZ > 0) !== (p.z > 0)) {
      if (p.y < NET_H + BALL_R) {
        sfx.net();
        v.z *= -0.18; v.x *= 0.3; v.y *= 0.35;
        p.z = prevZ > 0 ? 0.06 : -0.06;
        if (this.state === STATE.RALLY || this.state === STATE.TOSS) {
          if (this.serveShot && this.serveShot === this.match.server) {
            this.serveShot = null;
            this._fault();
          } else {
            this._pointTo(this.lastHitBy === "player" ? "opp" : "player", "into the net");
          }
        }
        return;
      }
    }

    // bounce
    if (p.y - BALL_R <= 0 && v.y < 0) {
      p.y = BALL_R;
      v.y = -v.y * 0.72;
      v.x *= 0.86; v.z *= 0.86;
      this.bounces++;
      sfx.bounce(clamp(Math.abs(v.y) / 6, 0.15, 1));
      this._judgeBounce();
    }

    // ball that escapes entirely
    if (Math.abs(p.x) > 24 || Math.abs(p.z) > 30 || p.y < -4) {
      this.ballLive = false;
      if (this.state === STATE.RALLY) {
        this._pointTo(this.lastHitBy === "player" ? "player" : "opp", "out of play");
      }
    }
  }

  _judgeBounce() {
    if (this.state !== STATE.RALLY) { return; }
    const p = this.ballPos;

    if (this.bounces === 1) {
      const hitter = this.lastHitBy;
      const wrongSide = hitter === "player" ? p.z > 0 : p.z < 0;
      const outside = Math.abs(p.x) > HALF_W + BALL_R || Math.abs(p.z) > HALF_L + BALL_R;

      if (this.serveShot && hitter === this.serveShot) {
        this.serveShot = null;
        const inBox = !wrongSide && Math.abs(p.x) <= HALF_W && Math.abs(p.z) <= SERVICE_LINE;
        if (!inBox) { this._fault(); }
        return;
      }
      if (wrongSide || outside) {
        this._pointTo(hitter === "player" ? "opp" : "player", "out");
      }
      return;
    }

    if (this.bounces >= 2) {
      this._pointTo(this.lastHitBy === "player" ? "player" : "opp", "two bounces");
    }
  }

  _oppServe() {
    const power = 0.45 + Math.random() * 0.35;
    const boxSide = (this.match.pPoints + this.match.oPoints) % 2 === 0 ? 1 : -1;
    const targetX = clamp(boxSide * 2.0 + (Math.random() - 0.5) * 2.4, -HALF_W + 0.4, HALF_W - 0.4);
    const targetZ = clamp(2.6 + power * 3.2, 2.0, SERVICE_LINE - 0.4);
    this._launch(targetX, targetZ, power, "opp");
    this.oppSwingAnim.t = 0;
    sfx.racket(power);
  }

  _ai(dt) {
    // --- your athlete tracks the ball sideways so you only handle timing ---
    let wantX = 0;
    if (this.ballLive && this.ballVel.z > 0) {
      wantX = clamp(this._predictX(PLAYER_LINE), -HALF_W - 1, HALF_W + 1);
    } else if (this.state === STATE.SERVE || this.state === STATE.TOSS) {
      wantX = this.match.server === "player" ? -0.9 : 0;
    }
    this.playerTargetX = wantX;
    const px = this.player.position;
    px.x = damp(px.x, this.playerTargetX, 6.5, dt);
    px.z = damp(px.z, PLAYER_LINE, 3, dt);

    // --- opponent -------------------------------------------------------
    const o = this.opp.position;
    if (this.ballLive && this.ballVel.z < 0) {
      this.oppTargetX = clamp(this._predictX(OPP_LINE) + (this.oppAimError || 0),
        -HALF_W - 1.4, HALF_W + 1.4);
    } else if (this.state !== STATE.RALLY) {
      this.oppTargetX = this.match.server === "opp" ? 0.9 : 0;
    }
    const maxStep = 7.2 * dt;
    const diff = clamp(this.oppTargetX - o.x, -maxStep, maxStep);
    o.x += diff;

    if (!this.twoPlayer
        && this.state === STATE.RALLY && this.lastHitBy === "player" && this.ballVel.z < 0) {
      const dz = this.ballPos.z - OPP_LINE;
      if (dz < 1.6 && dz > -2.6 && this.ballPos.y < 2.8) {
        const dx = Math.abs(this.ballPos.x - o.x);
        const reachable = dx < 1.35 && Math.random() > 0.07;
        if (reachable) {
          this._oppReturn(dx);
        }
      }
    }
  }

  /** Where the ball will cross a given z line, accounting for one bounce. */
  _predictX(lineZ) {
    const p = this.ballPos, v = this.ballVel;
    if (Math.abs(v.z) < 0.01) { return p.x; }
    const t = (lineZ - p.z) / v.z;
    if (t < 0) { return p.x; }
    return p.x + v.x * t * 0.92;
  }

  _oppReturn(dx) {
    const skill = clamp(1 - dx / 2.1, 0.15, 1);
    const power = clamp(0.32 + Math.random() * 0.45 + skill * 0.2, 0, 1);
    // aims away from where you are standing, with an error that grows when stretched
    let target = -Math.sign(this.player.position.x || (Math.random() - 0.5)) * HALF_W * 0.7;
    target += (Math.random() - 0.5) * (2.6 + (1 - skill) * 4.0);
    const targetX = clamp(target, -HALF_W - 0.6, HALF_W + 0.6);
    const targetZ = clamp(3.0 + power * 8.0, 2.5, HALF_L + 0.4);
    this._launch(targetX, targetZ, power, "opp");
    this.oppSwingAnim.t = 0;
    sfx.racket(power * 0.85);
    this.rally++;
  }

  _animate(dt, time) {
    this.ball.position.copy(this.ballPos);
    this.ball.visible = this.ballLive || this.state === STATE.TOSS;
    this.ballShadow.position.set(this.ballPos.x, 0.02, this.ballPos.z);
    const h = clamp(this.ballPos.y, 0, 6);
    const s = clamp(1 - h / 9, 0.32, 1);
    this.ballShadow.scale.setScalar(s);
    this.ballShadow.material.opacity = s * 0.85;
    this.ballShadow.visible = this.ball.visible;

    idlePose(this.player, time);
    idlePose(this.opp, time * 0.93 + 1.4);

    this._armSwing(this.player, this.playerRacket, this.swingAnim, dt, true);
    this._armSwing(this.opp, this.oppRacket, this.oppSwingAnim, dt, false);

    // face the net
    this.player.rotation.y = damp(this.player.rotation.y, Math.PI, 6, dt);
    this.opp.rotation.y = damp(this.opp.rotation.y, 0, 6, dt);
  }

  _armSwing(athlete, racket, anim, dt, isPlayer) {
    const arms = athlete.userData.arms;
    if (anim.t < 1) {
      anim.t = Math.min(1, anim.t + dt / 0.38);
      const e = anim.t;
      // wind up, then sweep across the body
      const sweep = e < 0.3 ? -e / 0.3 : (e - 0.3) / 0.7;
      const side = anim.side === undefined ? 1 : anim.side;
      arms.right.shoulder.rotation.x = -1.5 - sweep * 0.5;
      arms.right.shoulder.rotation.y = side * (-1.1 + sweep * 2.4);
      arms.right.shoulder.rotation.z = -0.5 - sweep * 0.4;
      arms.right.elbow.rotation.x = -0.5 + sweep * 0.4;
      athlete.userData.torso.rotation.y = side * (-0.35 + sweep * 0.8) * 0.6;
      racket.rotation.z = sweep * 1.4;
    } else {
      arms.right.shoulder.rotation.y = damp(arms.right.shoulder.rotation.y, 0, 8, dt);
      arms.right.shoulder.rotation.x = damp(arms.right.shoulder.rotation.x, -0.5, 8, dt);
      arms.right.shoulder.rotation.z = damp(arms.right.shoulder.rotation.z, -0.35, 8, dt);
      athlete.userData.torso.rotation.y = damp(athlete.userData.torso.rotation.y, 0, 8, dt);
      racket.rotation.z = damp(racket.rotation.z, 0, 8, dt);
    }
  }

  _camera(dt) {
    if (this.shake > 0.001) { this.shake *= Math.exp(-6 * dt); }
    const shake = this.shake > 0.001 ? this.shake : 0;
    const lookZ = this.ballLive ? clamp(this.ballPos.z * 0.35, -4, 6) : 0;

    const place = (cam, athlete, homeZ) => {
      cam.position.x = damp(cam.position.x, athlete.position.x * 0.42, 3.2, dt);
      cam.position.y = damp(cam.position.y, 5.4, 3, dt);
      cam.position.z = damp(cam.position.z, homeZ, 3, dt);
      if (shake) {
        cam.position.x += (Math.random() - 0.5) * shake;
        cam.position.y += (Math.random() - 0.5) * shake;
      }
      cam.lookAt(athlete.position.x * 0.25, 1.1, lookZ);
    };

    place(this.camera, this.player, PLAYER_LINE + 6.6);
    if (this.twoPlayer) { place(this.camera2, this.opp, OPP_LINE - 6.6); }
  }

  render(renderer) {
    renderSplit(renderer, this.scene, this.cameras);
  }
}
