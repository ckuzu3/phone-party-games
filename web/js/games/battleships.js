/*
 * Battleships.
 *
 * Tilt the phone to slide the crosshair over the enemy waters, press to fire.
 * A hit earns another shot; a miss passes the turn.
 *
 * Two grids are shown: your own fleet on the left, with every ship visible so
 * you can follow the damage, and your shots at the enemy on the right. With
 * two players on one screen this does expose your layout to whoever is sitting
 * next to you - that is a deliberate choice, not an oversight.
 */

import * as THREE from "../../lib/three.module.js";
import { addLights, skyDome, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";

const N = 10;                 // grid is 10 x 10
const CELL = 1.35;
const FLEET = [
  { name: "Carrier", size: 5 },
  { name: "Battleship", size: 4 },
  { name: "Cruiser", size: 3 },
  { name: "Submarine", size: 3 },
  { name: "Destroyer", size: 2 },
];

const NONE = 0, MISS = 1, HIT = 2;

export class BattleshipsGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Battleships";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 300);
    this.cameras = [this.camera];
    this._build();
  }

  // ------------------------------------------------------------ scenery

  _build() {
    const scene = this.scene;
    scene.add(skyDome(0x1d3f70, 0x9fc4e8));
    addLights(scene, { sky: 0xbcd6f5, ground: 0x1b3450, ambient: 0.95, sun: 1.2,
                       shadowRange: 26 });

    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({
        color: 0x1c4a72, roughness: 0.28, metalness: 0.45,
      })
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -0.35;
    scene.add(sea);

    const span = N * CELL;
    this.own = this._makeGrid(-span * 0.62);
    this.foe = this._makeGrid(span * 0.62);
    scene.add(this.own.group, this.foe.group);

    // the crosshair that slides over the enemy grid
    this.cursor = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(CELL * 0.52, 0.07, 8, 22),
      new THREE.MeshStandardMaterial({
        color: 0xffd166, emissive: 0x6b4a00, roughness: 0.4,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    this.cursor.add(ring);
    for (const rot of [0, Math.PI / 2]) {
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(CELL * 1.25, 0.06, 0.07),
        new THREE.MeshStandardMaterial({ color: 0xffd166 })
      );
      bar.rotation.y = rot;
      this.cursor.add(bar);
    }
    this.cursor.position.y = 0.45;
    scene.add(this.cursor);

    this.camera.position.set(0, 20, 15.5);
    this.camera.lookAt(0, 0, 0.5);
  }

  _makeGrid(offsetX) {
    const group = new THREE.Group();
    group.position.x = offsetX;
    const span = N * CELL;

    const base = new THREE.Mesh(
      new THREE.BoxGeometry(span + 0.7, 0.3, span + 0.7),
      new THREE.MeshStandardMaterial({ color: 0x14293f, roughness: 0.85 })
    );
    base.position.y = -0.18;
    base.receiveShadow = true;
    group.add(base);

    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(span, span),
      new THREE.MeshStandardMaterial({
        color: 0x225a86, roughness: 0.3, metalness: 0.4,
      })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.01;
    group.add(water);

    // grid lines
    const lineMat = new THREE.MeshBasicMaterial({
      color: 0x8fc4e8, transparent: true, opacity: 0.35,
    });
    for (let i = 0; i <= N; i++) {
      const p = -span / 2 + i * CELL;
      const a = new THREE.Mesh(new THREE.PlaneGeometry(0.045, span), lineMat);
      a.rotation.x = -Math.PI / 2;
      a.position.set(p, 0.02, 0);
      group.add(a);
      const b = new THREE.Mesh(new THREE.PlaneGeometry(span, 0.045), lineMat);
      b.rotation.x = -Math.PI / 2;
      b.position.set(0, 0.02, p);
      group.add(b);
    }

    const markers = new THREE.Group();
    group.add(markers);
    return { group, markers };
  }

  _cellPos(col, row) {
    const span = N * CELL;
    return new THREE.Vector3(
      -span / 2 + CELL * (col + 0.5), 0,
      -span / 2 + CELL * (row + 0.5));
  }

  // ------------------------------------------------------------ setup

  enter() {
    this.twoPlayer = this.ctx.humanCount() >= 2;
    this.humans = this.twoPlayer ? 2 : 1;

    this.boards = [this._newBoard(), this._newBoard()];
    this.active = 0;
    this.col = 4;
    this.row = 4;
    this.smoothCol = 4;
    this.smoothRow = 4;
    this.over = false;
    this.winner = null;
    this.lockUntil = performance.now() + 900;
    this.aiFireAt = 0;
    this.aiQueue = [];
    this.aiTried = new Set();
    this.restartAt = 0;

    this._brief();
    this._redraw();
    this._syncHud();
    this.ctx.ui.toast("BATTLESHIPS",
      this.twoPlayer ? "Player 1 fires first" : "Sink all five enemy ships", 2000);
  }

  exit() { }

  _brief() {
    for (let i = 0; i < this.humans; i++) {
      const c = this.ctx.seat(i);
      if (!c) { continue; }
      this.ctx.net.mode(c.pid,
        this.twoPlayer ? "Battleships - Player " + (i + 1) : "Battleships",
        "Tilt to move the crosshair over the enemy grid, press to fire.",
        "FIRE", "Press to fire at the marked square");
    }
  }

  _newBoard() {
    const board = {
      grid: new Array(N * N).fill(null),   // ship index or null
      shots: new Array(N * N).fill(NONE),  // shots received here
      ships: [],
    };
    for (let s = 0; s < FLEET.length; s++) {
      const spec = FLEET[s];
      let placed = false;
      let guard = 0;
      while (!placed && guard < 500) {
        guard++;
        const horiz = Math.random() < 0.5;
        const col = Math.floor(Math.random() * (horiz ? N - spec.size + 1 : N));
        const row = Math.floor(Math.random() * (horiz ? N : N - spec.size + 1));
        const cells = [];
        let ok = true;
        for (let k = 0; k < spec.size; k++) {
          const c = col + (horiz ? k : 0);
          const r = row + (horiz ? 0 : k);
          if (board.grid[r * N + c] !== null) { ok = false; break; }
          cells.push([c, r]);
        }
        if (!ok) { continue; }
        for (const [c, r] of cells) { board.grid[r * N + c] = s; }
        board.ships.push({ ...spec, cells, hits: 0, sunk: false, horiz });
        placed = true;
      }
    }
    return board;
  }

  // ------------------------------------------------------------ drawing

  /** Rebuild both grids for whoever is looking at the screen right now. */
  _redraw() {
    const viewer = this.active;
    const mine = this.boards[viewer];
    const theirs = this.boards[1 - viewer];

    // Your own fleet is always drawn in full, so you can see your ships and
    // where you are being hit. With two players sharing a screen that does
    // mean your opponent can see your layout too - shown by request.
    this._fillGrid(this.own, mine, true);
    this._fillGrid(this.foe, theirs, false);
  }

  _fillGrid(view, board, revealShips) {
    const markers = view.markers;
    while (markers.children.length) { markers.remove(markers.children[0]); }

    // sunk ships are revealed to everyone; your own fleet only when allowed
    for (const ship of board.ships) {
      if (!ship.sunk && !revealShips) { continue; }
      const a = this._cellPos(ship.cells[0][0], ship.cells[0][1]);
      const b = this._cellPos(
        ship.cells[ship.cells.length - 1][0], ship.cells[ship.cells.length - 1][1]);
      const hull = new THREE.Mesh(
        new THREE.BoxGeometry(
          ship.horiz ? Math.abs(b.x - a.x) + CELL * 0.72 : CELL * 0.72,
          0.42,
          ship.horiz ? CELL * 0.72 : Math.abs(b.z - a.z) + CELL * 0.72),
        new THREE.MeshStandardMaterial({
          color: ship.sunk ? 0x6b2020 : 0x69737f,
          roughness: 0.6, metalness: 0.35,
        })
      );
      hull.position.set((a.x + b.x) / 2, 0.22, (a.z + b.z) / 2);
      hull.castShadow = true;
      markers.add(hull);
    }

    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const shot = board.shots[r * N + c];
        if (shot === NONE) { continue; }
        const p = this._cellPos(c, r);
        let m;
        if (shot === HIT) {
          m = new THREE.Mesh(
            new THREE.ConeGeometry(CELL * 0.3, 0.9, 8),
            new THREE.MeshStandardMaterial({
              color: 0xff5a3c, emissive: 0x5a1200, roughness: 0.5,
            })
          );
          m.position.set(p.x, 0.62, p.z);
        } else {
          m = new THREE.Mesh(
            new THREE.CylinderGeometry(CELL * 0.14, CELL * 0.14, 0.22, 10),
            new THREE.MeshStandardMaterial({ color: 0xdfe8f2, roughness: 0.7 })
          );
          m.position.set(p.x, 0.14, p.z);
        }
        m.castShadow = true;
        markers.add(m);
      }
    }
  }

  // ------------------------------------------------------------ firing

  onButton(down, pid) {
    if (!down || this.over) { return; }
    if (performance.now() < this.lockUntil) { return; }
    const seat = this.ctx.seatOf(pid);
    if (seat < 0 || seat >= this.humans) { return; }
    if (seat !== this.active) { return; }
    this._fire(this.active, this.col, this.row);
  }

  onSwing() { /* the button is the trigger */ }

  _fire(shooter, col, row) {
    const target = this.boards[1 - shooter];
    const idx = row * N + col;
    if (target.shots[idx] !== NONE) {
      sfx.emptyClick();
      this.ctx.ui.toast("ALREADY FIRED THERE", "", 900);
      return;
    }

    const shipIdx = target.grid[idx];
    const label = shooter === 0
      ? (this.twoPlayer ? "P1" : "You") : (this.twoPlayer ? "P2" : "Enemy");

    if (shipIdx === null) {
      target.shots[idx] = MISS;
      sfx.splash();
      this.ctx.ui.toast(label + ": MISS", "", 1100);
      this._endTurn(false);
    } else {
      target.shots[idx] = HIT;
      const ship = target.ships[shipIdx];
      ship.hits++;
      sfx.crashInto(0.8);
      this.ctx.net.buzz(0, 90);
      if (ship.hits >= ship.size) {
        ship.sunk = true;
        this.ctx.ui.toast(label + " SANK THE " + ship.name.toUpperCase(), "", 1900);
        sfx.crash(1);
      } else {
        this.ctx.ui.toast(label + ": HIT", "fire again", 1100);
      }
      if (target.ships.every(s => s.sunk)) {
        this._win(shooter);
        return;
      }
      this._endTurn(true);          // a hit earns another shot
    }
    this._redraw();
    this._syncHud();
  }

  _endTurn(keepTurn) {
    this.lockUntil = performance.now() + 650;
    if (!keepTurn) {
      this.active = 1 - this.active;
      this.aiQueue = this.aiQueue.filter(Boolean);
    }
    if (this._activeIsAI()) {
      this.aiFireAt = performance.now() + 1100;
    }
    this._redraw();
  }

  _activeIsAI() {
    return !this.twoPlayer && this.active === 1 && !this.over;
  }

  _win(shooter) {
    this.over = true;
    this.winner = shooter;
    this.restartAt = performance.now() + 9000;
    const title = this.twoPlayer
      ? "PLAYER " + (shooter + 1) + " WINS"
      : (shooter === 0 ? "YOU WIN!" : "FLEET DESTROYED");
    this.ctx.ui.toast(title, "every ship sunk", 9000);
    sfx.cheer(shooter === 0 ? 1 : 0.3);
    this.ctx.net.buzz(0, 300);
    this._redraw();
    this._syncHud();
  }

  // ------------------------------------------------------------ the computer

  /**
   * Hunt then target: fire at random until something is hit, then work through
   * the neighbours of that hit before going back to hunting. Hunting sticks to
   * one colour of the chequerboard, since no ship can hide entirely inside the
   * other colour.
   */
  _aiFire() {
    const target = this.boards[0];
    let idx = null;

    while (this.aiQueue.length && idx === null) {
      const candidate = this.aiQueue.shift();
      if (target.shots[candidate] === NONE) { idx = candidate; }
    }

    if (idx === null) {
      const open = [];
      const parity = [];
      for (let i = 0; i < N * N; i++) {
        if (target.shots[i] !== NONE) { continue; }
        open.push(i);
        const c = i % N, r = Math.floor(i / N);
        if ((c + r) % 2 === 0) { parity.push(i); }
      }
      const pool = parity.length ? parity : open;
      if (!pool.length) { return; }
      idx = pool[Math.floor(Math.random() * pool.length)];
    }

    const col = idx % N, row = Math.floor(idx / N);
    const wasShip = target.grid[idx] !== null;
    if (wasShip) {
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const c = col + dc, r = row + dr;
        if (c < 0 || c >= N || r < 0 || r >= N) { continue; }
        const n = r * N + c;
        if (target.shots[n] === NONE) { this.aiQueue.push(n); }
      }
    }
    this._fire(1, col, row);
  }

  // ------------------------------------------------------------ update

  update(dt, time) {
    const showFoe = !this.over;
    this.cursor.visible = showFoe && !this._activeIsAI();

    if (!this.over && !this._activeIsAI()) {
      const c = this.ctx.seat(this.active);
      if (c) {
        const wantC = clamp((c.aim * 0.5 + 0.5) * (N - 1), 0, N - 1);
        const wantR = clamp((c.lean * 0.5 + 0.5) * (N - 1), 0, N - 1);
        this.smoothCol = damp(this.smoothCol, wantC, 11, dt);
        this.smoothRow = damp(this.smoothRow, wantR, 11, dt);
        const nc = Math.round(this.smoothCol), nr = Math.round(this.smoothRow);
        if (nc !== this.col || nr !== this.row) {
          this.col = nc; this.row = nr;
          sfx.move();
        }
      }
    }

    // park the crosshair on the enemy grid
    const p = this._cellPos(this.col, this.row);
    this.cursor.position.x = damp(this.cursor.position.x,
      this.foe.group.position.x + p.x, 14, dt);
    this.cursor.position.z = damp(this.cursor.position.z, p.z, 14, dt);
    this.cursor.position.y = 0.5 + Math.sin(time * 4) * 0.07;
    this.cursor.rotation.y = time * 0.7;

    if (this._activeIsAI() && this.aiFireAt && performance.now() > this.aiFireAt) {
      this.aiFireAt = 0;
      this._aiFire();
    }

    if (this.over && this.restartAt && performance.now() > this.restartAt) {
      this.restartAt = 0;
      this.enter();
    }

    this.ctx.ui.prompt(this.over ? ""
      : this._activeIsAI() ? "Enemy is taking aim…"
        : this.twoPlayer
          ? "Player " + (this.active + 1) + ": tilt to aim, press to fire"
          : "Tilt to aim, press to fire");
  }

  _syncHud() {
    const fleet = (board, label, colorClass) => {
      const pips = board.ships.map(s =>
        '<i class="' + (s.sunk ? "sunk" : "") + '" title="' + s.name + '">'
        + "▪".repeat(s.size) + '</i>').join("");
      const left = board.ships.filter(s => !s.sunk).length;
      return '<div class="bsFleet"><span class="tag ' + colorClass + '">' + label
        + '</span><span class="pips">' + pips + '</span>'
        + '<span class="left">' + left + '/' + board.ships.length + '</span></div>';
    };
    const p1 = this.twoPlayer ? "P1" : "YOU";
    const p2 = this.twoPlayer ? "P2" : "CPU";
    // each side's panel shows the state of their OWN fleet
    this.ctx.ui.hud(
      '<div class="bsHud">'
      + fleet(this.boards[0], p1, "blue")
      + fleet(this.boards[1], p2, "red")
      + '</div>'
      + '<div class="hudSub">'
      + (this.over
        ? (this.winner === 0 ? p1 : p2) + " wins"
        : (this.twoPlayer ? "Player " + (this.active + 1) : this.active === 0 ? "Your" : "Enemy")
          + " turn  &middot;  " + colName(this.col) + (this.row + 1))
      + '</div>'
    );
  }
}

function colName(c) { return "ABCDEFGHIJ"[c] || "?"; }
