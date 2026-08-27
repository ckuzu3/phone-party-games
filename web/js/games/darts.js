/*
 * Darts - 501 down to zero.
 *
 * Tilt to move the sight over the board, then throw the phone forward. Aim is
 * where the sight sits; a rushed or feeble throw scatters it, so a smooth
 * throw of moderate power is the accurate one.
 *
 * Scoring is worked out from where the dart lands in polar coordinates: the
 * sector gives the number, the radius gives single, double or treble.
 */

import * as THREE from "../../lib/three.module.js";
import { addLights, skyDome, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";

// clockwise from the top, as on a real board
const SECTORS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

const R_BULL = 0.0064;        // metres, real board dimensions
const R_OUTER_BULL = 0.0159;
const R_TREBLE_IN = 0.099;
const R_TREBLE_OUT = 0.107;
const R_DOUBLE_IN = 0.162;
const R_DOUBLE_OUT = 0.170;

const SCALE = 8;              // blown up so it reads on a TV
const BOARD_Z = -4;
const BOARD_Y = 1.73;
const START_SCORE = 501;

export class DartsGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Darts";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.05, 100);
    this.cameras = [this.camera];
    this.darts = [];
    this._build();
  }

  _build() {
    const scene = this.scene;
    scene.add(skyDome(0x181c28, 0x39405a));
    addLights(scene, { sky: 0xdfe8ff, ground: 0x2a2a34, ambient: 1.0, sun: 0.9,
                       shadowRange: 6 });
    const spot = new THREE.PointLight(0xfff0d8, 22, 12, 2);
    spot.position.set(0, BOARD_Y + 1.6, BOARD_Z + 1.6);
    scene.add(spot);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial({ color: 0x2c2f3c, roughness: 0.95 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 8),
      new THREE.MeshStandardMaterial({ color: 0x333a4d, roughness: 0.95 })
    );
    wall.position.set(0, 3, BOARD_Z - 0.12);
    scene.add(wall);

    this.board = new THREE.Group();
    this.board.position.set(0, BOARD_Y, BOARD_Z);
    scene.add(this.board);

    // backing
    const back = new THREE.Mesh(
      new THREE.CylinderGeometry(R_DOUBLE_OUT * SCALE + 0.09, R_DOUBLE_OUT * SCALE + 0.09, 0.05, 48),
      new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 })
    );
    back.rotation.x = Math.PI / 2;
    this.board.add(back);

    const ring = (inner, outer, colorA, colorB, z) => {
      for (let i = 0; i < 20; i++) {
        const start = (i - 0.5) * (Math.PI * 2 / 20) + Math.PI / 2;
        const geo = new THREE.RingGeometry(inner * SCALE, outer * SCALE, 6, 1,
          -start - Math.PI * 2 / 20, Math.PI * 2 / 20);
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          color: i % 2 === 0 ? colorA : colorB, roughness: 0.8, side: THREE.DoubleSide,
        }));
        mesh.position.z = z;
        this.board.add(mesh);
      }
    };
    ring(R_OUTER_BULL, R_TREBLE_IN, 0x0e0e0e, 0xf0e2c4, 0.03);
    ring(R_TREBLE_IN, R_TREBLE_OUT, 0xc0392b, 0x2f7d43, 0.032);
    ring(R_TREBLE_OUT, R_DOUBLE_IN, 0x0e0e0e, 0xf0e2c4, 0.03);
    ring(R_DOUBLE_IN, R_DOUBLE_OUT, 0xc0392b, 0x2f7d43, 0.032);

    const bullOuter = new THREE.Mesh(
      new THREE.CircleGeometry(R_OUTER_BULL * SCALE, 24),
      new THREE.MeshStandardMaterial({ color: 0x2f7d43, roughness: 0.7 })
    );
    bullOuter.position.z = 0.033;
    this.board.add(bullOuter);
    const bull = new THREE.Mesh(
      new THREE.CircleGeometry(R_BULL * SCALE, 20),
      new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.7 })
    );
    bull.position.z = 0.035;
    this.board.add(bull);

    // the sight
    this.sight = new THREE.Group();
    const reticle = new THREE.Mesh(
      new THREE.TorusGeometry(0.075, 0.011, 8, 22),
      new THREE.MeshBasicMaterial({ color: 0x7fe3ff })
    );
    this.sight.add(reticle);
    for (const rot of [0, Math.PI / 2]) {
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.008, 0.008),
        new THREE.MeshBasicMaterial({ color: 0x7fe3ff })
      );
      bar.rotation.z = rot;
      this.sight.add(bar);
    }
    this.sight.position.z = 0.09;
    this.board.add(this.sight);

    this.camera.position.set(0, BOARD_Y, BOARD_Z + 2.9);
    this.camera.lookAt(0, BOARD_Y, BOARD_Z);
  }

  _makeDart(color) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.014, 0.02, 0.2, 8),
      new THREE.MeshStandardMaterial({ color: 0xb8bcc8, roughness: 0.3, metalness: 0.7 })
    );
    body.rotation.x = Math.PI / 2;
    g.add(body);
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(0.012, 0.09, 8),
      new THREE.MeshStandardMaterial({ color: 0x8a8f9c, metalness: 0.8, roughness: 0.3 })
    );
    tip.rotation.x = -Math.PI / 2;
    tip.position.z = -0.14;
    g.add(tip);
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(
        new THREE.PlaneGeometry(0.055, 0.075),
        new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.8 })
      );
      fin.position.z = 0.13;
      fin.rotation.z = (i / 4) * Math.PI * 2;
      fin.rotation.y = Math.PI / 2;
      g.add(fin);
    }
    return g;
  }

  // ------------------------------------------------------------ scoring

  /** Score for a landing point in board metres, relative to the centre. */
  _scoreAt(x, y) {
    const r = Math.hypot(x, y);
    if (r <= R_BULL) { return { value: 50, label: "BULL" }; }
    if (r <= R_OUTER_BULL) { return { value: 25, label: "25" }; }
    if (r > R_DOUBLE_OUT) { return { value: 0, label: "MISS" }; }

    // angle measured clockwise from straight up
    let a = Math.atan2(x, y);
    if (a < 0) { a += Math.PI * 2; }
    const idx = Math.floor((a + Math.PI / 20) / (Math.PI * 2 / 20)) % 20;
    const num = SECTORS[idx];

    if (r >= R_DOUBLE_IN) { return { value: num * 2, label: "D" + num }; }
    if (r >= R_TREBLE_IN && r <= R_TREBLE_OUT) { return { value: num * 3, label: "T" + num }; }
    return { value: num, label: String(num) };
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    const n = Math.min(2, this.ctx.humanCount());
    this.players = [];
    for (let i = 0; i < n; i++) {
      this.players.push({ seat: i, score: START_SCORE, darts: 0, best: 0, thisTurn: [] });
    }
    this.active = 0;
    this.over = false;
    this.aim = { x: 0, y: 0 };
    this.throwing = null;
    this.clearAt = 0;
    for (const d of this.darts) { this.scene.remove(d); }
    this.darts = [];
    this._brief();
    this._syncHud();
    this.ctx.ui.toast("DARTS", "501 down to exactly zero", 2000);
  }

  exit() { }

  _brief() {
    for (let i = 0; i < this.players.length; i++) {
      const c = this.ctx.seat(i);
      if (!c) { continue; }
      this.ctx.net.mode(c.pid,
        this.players.length > 1 ? "Darts - P" + (i + 1) : "Darts",
        "Tilt to move the sight, then throw the phone forward.",
        "THROW", "Throw forward to release");
    }
  }

  onSwing(swing) {
    if (this.over || this.throwing || this.clearAt) { return; }
    const seat = this.ctx.seatOf(swing.pid);
    if (seat !== this.active || seat < 0) { return; }
    if (swing.power < 0.1) { return; }

    // a smooth, medium throw is the accurate one
    const off = Math.abs(swing.power - 0.55);
    const spread = (0.004 + off * 0.055) * (1 + Math.abs(swing.yaw) / 400);
    const land = {
      x: this.aim.x + (Math.random() - 0.5) * spread * 2,
      y: this.aim.y + (Math.random() - 0.5) * spread * 2,
    };
    this.throwing = { land, t: 0 };
    sfx.whoosh();
  }

  _land(land) {
    const p = this.players[this.active];
    const hit = this._scoreAt(land.x, land.y);

    const mesh = this._makeDart(this.active ? 0xff7a6b : 0x7fe3ff);
    mesh.position.set(land.x * SCALE, land.y * SCALE, 0.14);
    mesh.rotation.z = (Math.random() - 0.5) * 0.4;
    this.board.add(mesh);
    this.darts.push(mesh);

    p.darts++;
    p.thisTurn.push(hit.label);
    const after = p.score - hit.value;

    if (after < 0 || after === 1) {
      this.ctx.ui.toast("BUST", hit.label + " - score stays at " + p.score, 1600);
      sfx.point(false);
      this._endTurn(true);
      return;
    }

    p.score = after;
    sfx.noise(0.08, 2400, { gain: 0.16, q: 2 });
    if (hit.value === 0) {
      this.ctx.ui.toast("MISS", "", 900);
    } else if (hit.value >= 40) {
      this.ctx.ui.toast(hit.label, "+" + hit.value, 1100);
      sfx.cheer(0.35);
    }
    this.ctx.net.buzz(this._pid(), 40 + hit.value);

    if (after === 0) {
      this.over = true;
      const who = this.players.length > 1 ? "PLAYER " + (this.active + 1) + " WINS" : "CHECKOUT!";
      this.ctx.ui.toast(who, "in " + p.darts + " darts", 9000);
      sfx.cheer(1);
      this._syncHud();
      return;
    }

    if (p.thisTurn.length >= 3) { this._endTurn(false); }
    this._syncHud();
  }

  _endTurn(bust) {
    const p = this.players[this.active];
    const turnTotal = bust ? 0 : START_SCORE;   // only used for the label below
    p.best = Math.max(p.best, 0);
    this.clearAt = performance.now() + 1400;
  }

  _pid() {
    const c = this.ctx.seat(this.active);
    return c ? c.pid : 0;
  }

  // ------------------------------------------------------------ update

  update(dt, time) {
    const c = this.ctx.seat(this.active);
    if (c && !this.throwing && !this.over) {
      // the sight drifts over the board with the phone's tilt
      this.aim.x = damp(this.aim.x, clamp(c.aim, -1, 1) * R_DOUBLE_OUT * 1.05, 7, dt);
      this.aim.y = damp(this.aim.y, clamp(-c.lean, -1, 1) * R_DOUBLE_OUT * 1.05, 7, dt);
    }
    this.sight.position.x = this.aim.x * SCALE;
    this.sight.position.y = this.aim.y * SCALE;
    this.sight.visible = !this.over && !this.throwing;

    if (this.throwing) {
      this.throwing.t += dt;
      if (this.throwing.t > 0.22) {
        const land = this.throwing.land;
        this.throwing = null;
        this._land(land);
      }
    }

    if (this.clearAt && performance.now() > this.clearAt) {
      this.clearAt = 0;
      for (const d of this.darts) { this.board.remove(d); }
      this.darts = [];
      this.players[this.active].thisTurn = [];
      if (this.players.length > 1) { this.active = 1 - this.active; }
      this._syncHud();
    }

    this.ctx.ui.prompt(this.over ? ""
      : this.players.length > 1
        ? "Player " + (this.active + 1) + " to throw"
        : "Tilt to aim, throw the phone forward");
  }

  _syncHud() {
    const cards = this.players.map((p, i) =>
      '<div class="shotCard' + (i === this.active && !this.over ? " on" : "") + '">'
      + (this.players.length > 1 ? '<span class="tag ' + (i ? "red" : "blue")
         + '">P' + (i + 1) + "</span>" : "")
      + '<span class="big">' + p.score + '</span>'
      + '<span class="sub">' + (p.thisTurn.length ? p.thisTurn.join("  ") : "&nbsp;")
      + '</span></div>').join("");
    this.ctx.ui.hud('<div class="shotHud">' + cards + '</div>'
      + '<div class="hudSub">' + (this.over ? "game shot"
        : "dart " + (this.players[this.active].thisTurn.length + 1) + " of 3") + '</div>');
  }
}
