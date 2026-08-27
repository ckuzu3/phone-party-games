/*
 * Light Cycles - up to four players on one screen.
 *
 * Everyone moves forward all the time and leaves a solid wall behind them.
 * Tilt the phone left or right to turn a quarter turn; the tilt has to return
 * near centre before it will turn again, so a held lean does not spin you.
 * Last one riding wins.
 *
 * The arena is a grid and every cycle steps one cell at a time. All of them
 * are moved together and only then tested, so two riders entering the same
 * cell take each other out rather than the one updated first winning.
 */

import * as THREE from "../../lib/three.module.js";
import { addLights, skyDome, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";

const GRID = 52;              // cells across
const CELL = 0.62;
const START_STEP = 0.115;     // seconds per cell
const MIN_STEP = 0.055;
const SPEED_UP = 0.9995;      // per step
const TURN_RESET = 0.32;      // tilt must fall back inside this before turning again
const TURN_TRIGGER = 0.55;

const COLORS = [0x7fe3ff, 0xffd166, 0xa0f0a0, 0xff9ecb];
const NAMES = ["P1", "P2", "P3", "P4"];
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];   // N, E, S, W

export class LightCyclesGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Light Cycles";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.1, 200);
    this.cameras = [this.camera];
    this.trailMeshes = [];
    this._build();
  }

  _build() {
    const scene = this.scene;
    scene.add(skyDome(0x05070f, 0x141d33));
    addLights(scene, { sky: 0x8fb0ff, ground: 0x101828, ambient: 0.7, sun: 0.5,
                       shadowRange: 20 });

    const span = GRID * CELL;
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(span, 0.2, span),
      new THREE.MeshStandardMaterial({ color: 0x0d1220, roughness: 0.55, metalness: 0.3 })
    );
    floor.position.y = -0.1;
    floor.receiveShadow = true;
    scene.add(floor);

    // grid lines, drawn once
    const lineMat = new THREE.MeshBasicMaterial({
      color: 0x1d3a5c, transparent: true, opacity: 0.55,
    });
    for (let i = 0; i <= GRID; i += 2) {
      const p = -span / 2 + i * CELL;
      for (const horiz of [true, false]) {
        const geo = horiz
          ? new THREE.PlaneGeometry(span, 0.02)
          : new THREE.PlaneGeometry(0.02, span);
        const m = new THREE.Mesh(geo, lineMat);
        m.rotation.x = -Math.PI / 2;
        m.position.set(horiz ? 0 : p, 0.005, horiz ? p : 0);
        scene.add(m);
      }
    }

    // arena walls
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x2f6fe0, emissive: 0x0d2a55, roughness: 0.4,
    });
    for (const [x, z, w, d] of [
      [0, -span / 2, span, 0.3], [0, span / 2, span, 0.3],
      [-span / 2, 0, 0.3, span], [span / 2, 0, 0.3, span],
    ]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 1.1, d), wallMat);
      wall.position.set(x, 0.55, z);
      scene.add(wall);
    }

    this.heads = [];
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(CELL * 0.7, CELL * 0.5, CELL * 1.1),
        new THREE.MeshStandardMaterial({
          color: COLORS[i], emissive: COLORS[i], emissiveIntensity: 0.5, roughness: 0.3,
        })
      );
      body.position.y = CELL * 0.3;
      body.castShadow = true;
      g.add(body);
      scene.add(g);
      this.heads.push(g);
    }

    this.camera.position.set(0, GRID * CELL * 0.92, GRID * CELL * 0.62);
    this.camera.lookAt(0, 0, 0);
  }

  _cellPos(cx, cy) {
    const span = GRID * CELL;
    return { x: -span / 2 + (cx + 0.5) * CELL, z: -span / 2 + (cy + 0.5) * CELL };
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    const humans = clamp(this.ctx.humanCount(), 1, 4);
    // always at least two riders, so a solo player has someone to beat
    this.count = Math.max(2, humans);
    this.humans = humans;

    for (const m of this.trailMeshes) { this.scene.remove(m); }
    this.trailMeshes = [];
    this.occupied = new Uint8Array(GRID * GRID);

    const q = Math.floor(GRID / 4);
    const starts = [
      { x: q, y: GRID - q, dir: 0 },
      { x: GRID - q, y: q, dir: 2 },
      { x: q, y: q, dir: 1 },
      { x: GRID - q, y: GRID - q, dir: 3 },
    ];

    this.riders = [];
    for (let i = 0; i < this.count; i++) {
      const s = starts[i];
      this.riders.push({
        idx: i, x: s.x, y: s.y, dir: s.dir, alive: true,
        human: i < humans, armed: true, place: 0,
      });
      this.occupied[s.y * GRID + s.x] = i + 1;
    }

    this.step = START_STEP;
    this.acc = 0;
    this.over = false;
    this.startAt = performance.now() + 1600;
    this.restartAt = 0;
    this.finished = 0;
    this._brief();
    this._syncHud();
    this.ctx.ui.toast("LIGHT CYCLES",
      this.count + " riders  ·  tilt to turn  ·  last one riding wins", 2400);
  }

  exit() { }

  _brief() {
    for (let i = 0; i < this.humans; i++) {
      const c = this.ctx.seat(i);
      if (!c) { continue; }
      this.ctx.net.mode(c.pid, "Light Cycles - " + NAMES[i],
        "Tilt left or right to turn. Let the phone come back to centre "
        + "before turning again.",
        "-", "no button needed - just tilt");
    }
  }

  // ------------------------------------------------------------ update

  update(dt, time) {
    if (this.over) {
      if (this.restartAt && performance.now() > this.restartAt) {
        this.restartAt = 0; this.enter(); return;
      }
    } else if (performance.now() > this.startAt) {
      this._readTurns();
      this.acc += dt;
      while (this.acc >= this.step && !this.over) {
        this.acc -= this.step;
        this._advance();
        this.step = Math.max(MIN_STEP, this.step * SPEED_UP);
      }
    }

    // draw the riders
    for (let i = 0; i < 4; i++) {
      const head = this.heads[i];
      const r = this.riders[i];
      head.visible = !!r && r.alive;
      if (!r || !r.alive) { continue; }
      const p = this._cellPos(r.x, r.y);
      head.position.x = damp(head.position.x, p.x, 22, dt);
      head.position.z = damp(head.position.z, p.z, 22, dt);
      head.rotation.y = r.dir * -Math.PI / 2;
    }

    this.ctx.ui.prompt(this.over ? ""
      : performance.now() < this.startAt ? "Get ready…" : "");
  }

  /** A turn fires once per lean; the phone must return to centre to re-arm. */
  _readTurns() {
    for (const r of this.riders) {
      if (!r.alive || !r.human) { continue; }
      const c = this.ctx.seat(r.idx);
      if (!c) { continue; }
      const a = clamp(c.aim, -1, 1);
      if (Math.abs(a) < TURN_RESET) { r.armed = true; continue; }
      if (!r.armed || Math.abs(a) < TURN_TRIGGER) { continue; }
      r.dir = (r.dir + (a > 0 ? 1 : 3)) % 4;
      r.armed = false;
      sfx.move();
    }
  }

  _advance() {
    const alive = this.riders.filter(r => r.alive);
    // computer riders decide after the humans, using the same board
    for (const r of alive) { if (!r.human) { this._think(r); } }

    // work out everyone's next cell first, then judge them together
    const next = new Map();
    for (const r of alive) {
      const [dx, dy] = DIRS[r.dir];
      next.set(r, { x: r.x + dx, y: r.y + dy });
    }

    const dead = [];
    for (const r of alive) {
      const n = next.get(r);
      const out = n.x < 0 || n.y < 0 || n.x >= GRID || n.y >= GRID;
      const intoWall = !out && this.occupied[n.y * GRID + n.x] !== 0;
      let headOn = false;
      for (const other of alive) {
        if (other === r) { continue; }
        const o = next.get(other);
        if (o.x === n.x && o.y === n.y) { headOn = true; }
      }
      if (out || intoWall || headOn) { dead.push(r); }
    }

    // lay the new trail for everyone who survived
    for (const r of alive) {
      if (dead.includes(r)) { continue; }
      const n = next.get(r);
      r.x = n.x; r.y = n.y;
      this.occupied[n.y * GRID + n.x] = r.idx + 1;
      this._layTrail(r, n.x, n.y);
    }

    for (const r of dead) {
      r.alive = false;
      r.place = this.count - this.finished;
      this.finished++;
      sfx.crashInto(0.8);
      if (r.human) { this.ctx.net.buzz(this._pidOf(r), 200); }
    }
    if (dead.length) { this._checkEnd(); }
  }

  _layTrail(r, cx, cy) {
    const p = this._cellPos(cx, cy);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(CELL * 0.92, CELL * 0.8, CELL * 0.92),
      new THREE.MeshStandardMaterial({
        color: COLORS[r.idx], emissive: COLORS[r.idx],
        emissiveIntensity: 0.35, roughness: 0.4,
      })
    );
    mesh.position.set(p.x, CELL * 0.4, p.z);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.trailMeshes.push(mesh);
  }

  /** Keep going while it is safe, otherwise take the roomiest turn. */
  _think(r) {
    const room = (dir) => {
      const [dx, dy] = DIRS[dir];
      let n = 0, x = r.x, y = r.y;
      while (n < 14) {
        x += dx; y += dy;
        if (x < 0 || y < 0 || x >= GRID || y >= GRID) { break; }
        if (this.occupied[y * GRID + x] !== 0) { break; }
        n++;
      }
      return n;
    };
    const straight = room(r.dir);
    if (straight > 3 && Math.random() > 0.06) { return; }
    const left = (r.dir + 3) % 4, right = (r.dir + 1) % 4;
    const lr = room(left), rr = room(right);
    if (lr === 0 && rr === 0) { return; }              // nowhere to go
    if (lr === rr) { r.dir = Math.random() < 0.5 ? left : right; }
    else { r.dir = lr > rr ? left : right; }
  }

  _pidOf(r) {
    const c = this.ctx.seat(r.idx);
    return c ? c.pid : 0;
  }

  _checkEnd() {
    const alive = this.riders.filter(r => r.alive);
    if (alive.length > 1) { this._syncHud(); return; }

    this.over = true;
    this.restartAt = performance.now() + 9000;
    if (alive.length === 1) {
      const w = alive[0];
      w.place = 1;
      const title = this.humans > 1
        ? NAMES[w.idx] + " WINS"
        : (w.human ? "YOU WIN!" : "THE COMPUTER WINS");
      this.ctx.ui.toast(title, "last one riding", 9000);
      sfx.cheer(w.human ? 1 : 0.3);
    } else {
      this.ctx.ui.toast("EVERYONE CRASHED", "no winner", 9000);
      sfx.point(false);
    }
    this._syncHud();
  }

  _syncHud() {
    const cells = this.riders.map(r => {
      const label = r.human ? NAMES[r.idx] : "CPU";
      return '<div class="cycleCard' + (r.alive ? "" : " out")
        + '" style="--c:#' + COLORS[r.idx].toString(16).padStart(6, "0") + '">'
        + '<i></i><span>' + label + '</span>'
        + '<b>' + (r.alive ? "riding" : (r.place === 1 ? "winner" : "#" + r.place))
        + '</b></div>';
    }).join("");
    this.ctx.ui.hud('<div class="cycleHud">' + cells + '</div>'
      + '<div class="hudSub">'
      + (this.over ? "race over"
        : Math.round(1 / this.step) + " cells per second") + '</div>');
  }
}
