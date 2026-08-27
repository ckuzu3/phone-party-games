/*
 * Four in a Row.
 *
 * Tilt the phone left and right to slide the disc across the top, press the
 * button to drop it. Two phones play each other; with one phone the yellow
 * side is played by a negamax search.
 *
 * The board is held as a flat array of 42 cells so the search can copy and
 * undo moves cheaply - the 3D discs are only a view of it.
 */

import * as THREE from "../../lib/three.module.js";
import { addLights, skyDome, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";

const COLS = 7;
const ROWS = 6;
const EMPTY = 0;
const RED = 1;                 // player one
const YELLOW = 2;              // player two, or the computer

const CELL = 1.25;             // spacing between holes
const DISC_R = 0.52;
const AI_DEPTH = 6;

const TABLE_TOP = -1.6;        // height of the surface the frame stands on
const LEG_H = 1.0;             // clearance between that surface and the frame

const DISC_COLOR = { 1: 0xe2574a, 2: 0xffd166 };
const SIDE_NAME = { 1: "RED", 2: "YELLOW" };

export class ConnectFourGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Four in a Row";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.1, 200);
    this.cameras = [this.camera];
    this.discs = [];
    this._build();
  }

  // ------------------------------------------------------------ scenery

  _build() {
    const scene = this.scene;
    scene.add(skyDome(0x24406e, 0x8fb4dd));
    addLights(scene, { sky: 0xcddcf5, ground: 0x37405c, ambient: 1.0, sun: 1.25,
                       shadowRange: 12 });

    const tableH = 0.6;
    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(14, 14, tableH, 40),
      new THREE.MeshStandardMaterial({ color: 0x2c3350, roughness: 0.9 })
    );
    table.position.y = TABLE_TOP - tableH / 2;
    table.receiveShadow = true;
    scene.add(table);

    const w = COLS * CELL, h = ROWS * CELL;
    const barW = CELL - DISC_R * 2 + 0.16;
    this.originX = -(w - CELL) / 2;

    /*
     * Stand the grid on its legs above the table rather than guessing a
     * height. The lowest part of the frame is the bar half a cell below row
     * zero, so working back from the table top is what keeps the bottom row of
     * holes above the surface - a hand-picked offset here previously sank that
     * whole row underneath it.
     */
    this.originY = TABLE_TOP + LEG_H + CELL / 2 + barW / 2;

    // The frame is drawn as slats between the holes rather than a solid slab
    // with holes punched through it - far cheaper than CSG and looks the same
    // from the front.
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x2f6fe0, roughness: 0.45, metalness: 0.15,
    });
    for (let c = 0; c <= COLS; c++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(barW, h + 0.5, 0.75), frameMat);
      bar.position.set(this.originX + c * CELL - CELL / 2, this.originY + h / 2 - CELL / 2, 0);
      bar.castShadow = true;
      scene.add(bar);
    }
    for (let r = 0; r <= ROWS; r++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w + 0.5, barW, 0.75), frameMat);
      bar.position.set(this.originX + w / 2 - CELL / 2, this.originY + r * CELL - CELL / 2, 0);
      bar.castShadow = true;
      scene.add(bar);
    }
    // back panel so discs read against something solid
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(w + 0.5, h + 0.5),
      new THREE.MeshStandardMaterial({ color: 0x1b2b5c, roughness: 0.9 })
    );
    back.position.set(this.originX + w / 2 - CELL / 2, this.originY + h / 2 - CELL / 2, -0.42);
    scene.add(back);

    // legs bridging the table top and the underside of the frame
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, LEG_H + 0.25, 2.2), frameMat);
      leg.position.set(side * (w / 2 - 0.7), TABLE_TOP + LEG_H / 2, 0);
      leg.castShadow = true;
      scene.add(leg);
    }

    // the disc waiting to be dropped
    this.hover = this._makeDisc(RED);
    this.hover.position.set(this.originX, this.originY + ROWS * CELL - CELL / 2 + 1.1, 0);
    scene.add(this.hover);

    // a soft column highlight under the hovering disc
    this.colGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(CELL * 0.92, ROWS * CELL),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.09, depthWrite: false,
      })
    );
    this.colGlow.position.z = -0.3;
    scene.add(this.colGlow);

    this.camera.position.set(0, this.originY + ROWS * CELL / 2, 13.5);
    this.camera.lookAt(0, this.originY + ROWS * CELL / 2 - 0.6, 0);
  }

  _makeDisc(side) {
    const geo = new THREE.CylinderGeometry(DISC_R, DISC_R, 0.34, 24);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: DISC_COLOR[side], roughness: 0.35, metalness: 0.2,
    }));
    mesh.rotation.x = Math.PI / 2;
    mesh.castShadow = true;
    return mesh;
  }

  _cellPos(col, row) {
    return new THREE.Vector3(
      this.originX + col * CELL,
      this.originY + row * CELL,
      0);
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    this.twoPlayer = this.ctx.humanCount() >= 2;
    this.board = new Array(COLS * ROWS).fill(EMPTY);
    this.turn = RED;
    this.col = 3;
    this.smoothCol = 3;
    this.falling = null;
    this.winner = null;
    this.winCells = null;
    this.over = false;
    this.moveLock = 0;
    this.aiThinkAt = 0;
    this.restartAt = 0;

    for (const d of this.discs) { this.scene.remove(d.mesh); }
    this.discs = [];
    this.hover.material.color.setHex(DISC_COLOR[RED]);
    this.hover.visible = true;

    this._brief();
    this._syncHud();
    this.ctx.ui.toast("FOUR IN A ROW",
      this.twoPlayer ? "Red is player 1, yellow is player 2" : "You are red", 1900);
  }

  exit() { }

  _brief() {
    const hint = "Tilt left and right to pick a column, press to drop.";
    for (let i = 0; i < (this.twoPlayer ? 2 : 1); i++) {
      const c = this.ctx.seat(i);
      if (!c) { continue; }
      this.ctx.net.mode(c.pid,
        this.twoPlayer ? "Four in a Row - " + SIDE_NAME[i + 1] : "Four in a Row",
        hint, "DROP", "Press to drop your disc");
    }
  }

  /** Which side a controller plays, or null if it is not their game. */
  _sideOf(pid) {
    const seat = this.ctx.seatOf(pid);
    if (seat === 0 || seat === -1) { return RED; }
    if (seat === 1 && this.twoPlayer) { return YELLOW; }
    return null;
  }

  _isHuman(side) {
    return side === RED || this.twoPlayer;
  }

  // ------------------------------------------------------------ board logic

  _at(board, col, row) { return board[row * COLS + col]; }

  _drop(board, col, side) {
    for (let r = 0; r < ROWS; r++) {
      if (board[r * COLS + col] === EMPTY) {
        board[r * COLS + col] = side;
        return r;
      }
    }
    return -1;
  }

  _canPlay(board, col) {
    return board[(ROWS - 1) * COLS + col] === EMPTY;
  }

  /** The four cells that complete a line through (col,row), or null. */
  _winFrom(board, col, row) {
    const side = this._at(board, col, row);
    if (side === EMPTY) { return null; }
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (const [dx, dy] of dirs) {
      const cells = [[col, row]];
      for (const sign of [1, -1]) {
        let c = col + dx * sign, r = row + dy * sign;
        while (c >= 0 && c < COLS && r >= 0 && r < ROWS
               && this._at(board, c, r) === side) {
          cells.push([c, r]);
          c += dx * sign; r += dy * sign;
        }
      }
      if (cells.length >= 4) { return cells; }
    }
    return null;
  }

  _full(board) {
    for (let c = 0; c < COLS; c++) { if (this._canPlay(board, c)) { return false; } }
    return true;
  }

  // ------------------------------------------------------------ the computer

  /**
   * Negamax with alpha-beta. The board is small enough that a plain search to
   * six ply is instant, so there is no need for anything cleverer.
   */
  _bestMove(board, side) {
    const order = [3, 2, 4, 1, 5, 0, 6];     // centre columns first prunes better
    let bestCol = order.find(c => this._canPlay(board, c));
    let bestScore = -Infinity;
    for (const col of order) {
      if (!this._canPlay(board, col)) { continue; }
      const copy = board.slice();
      const row = this._drop(copy, col, side);
      let score;
      if (this._winFrom(copy, col, row)) {
        score = 100000;
      } else {
        score = -this._search(copy, AI_DEPTH - 1, -Infinity, Infinity, other(side));
      }
      if (score > bestScore) { bestScore = score; bestCol = col; }
    }
    return bestCol;
  }

  _search(board, depth, alpha, beta, toMove) {
    if (this._full(board)) { return 0; }
    if (depth === 0) { return this._evaluate(board, toMove); }

    let best = -Infinity;
    for (const col of [3, 2, 4, 1, 5, 0, 6]) {
      if (!this._canPlay(board, col)) { continue; }
      const copy = board.slice();
      const row = this._drop(copy, col, toMove);
      let score;
      if (this._winFrom(copy, col, row)) {
        score = 100000 - (AI_DEPTH - depth);        // prefer quicker wins
      } else {
        score = -this._search(copy, depth - 1, -beta, -alpha, other(toMove));
      }
      if (score > best) { best = score; }
      if (best > alpha) { alpha = best; }
      if (alpha >= beta) { break; }
    }
    return best;
  }

  /** Count how threatening every four-cell window is. */
  _evaluate(board, me) {
    const foe = other(me);
    let score = 0;
    const windows = this._windows();
    for (const win of windows) {
      let mine = 0, theirs = 0;
      for (const idx of win) {
        const v = board[idx];
        if (v === me) { mine++; } else if (v === foe) { theirs++; }
      }
      if (mine && theirs) { continue; }
      if (mine === 3) { score += 55; }
      else if (mine === 2) { score += 8; }
      else if (theirs === 3) { score -= 62; }   // block slightly harder than build
      else if (theirs === 2) { score -= 9; }
    }
    // the centre column is worth holding
    for (let r = 0; r < ROWS; r++) {
      const v = board[r * COLS + 3];
      if (v === me) { score += 6; } else if (v === foe) { score -= 6; }
    }
    return score;
  }

  _windows() {
    if (this._winCache) { return this._winCache; }
    const out = [];
    const push = (cells) => out.push(cells.map(([c, r]) => r * COLS + c));
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (c + 3 < COLS) { push([[c, r], [c + 1, r], [c + 2, r], [c + 3, r]]); }
        if (r + 3 < ROWS) { push([[c, r], [c, r + 1], [c, r + 2], [c, r + 3]]); }
        if (c + 3 < COLS && r + 3 < ROWS) {
          push([[c, r], [c + 1, r + 1], [c + 2, r + 2], [c + 3, r + 3]]);
        }
        if (c + 3 < COLS && r - 3 >= 0) {
          push([[c, r], [c + 1, r - 1], [c + 2, r - 2], [c + 3, r - 3]]);
        }
      }
    }
    this._winCache = out;
    return out;
  }

  // ------------------------------------------------------------ moves

  onButton(down, pid) {
    if (!down || this.over || this.falling) { return; }
    const side = this._sideOf(pid);
    if (side === null || side !== this.turn) { return; }
    if (!this._isHuman(this.turn)) { return; }
    this._play(this.col);
  }

  onSwing() { /* the button is the only action */ }

  _play(col) {
    if (!this._canPlay(this.board, col)) {
      sfx.point(false);
      return;
    }
    const side = this.turn;
    const row = this._drop(this.board, col, side);

    const mesh = this._makeDisc(side);
    const from = this._cellPos(col, ROWS - 1).y + 2.4;
    mesh.position.set(this._cellPos(col, row).x, from, 0);
    this.scene.add(mesh);
    const target = this._cellPos(col, row);
    this.discs.push({ mesh, col, row, side });
    this.falling = { mesh, targetY: target.y, vy: 0, col, row, side, bounces: 0 };
    sfx.tone(520, 0.05, { type: "square", gain: 0.1 });
  }

  _settled(move) {
    const line = this._winFrom(this.board, move.col, move.row);
    if (line) {
      this.winner = move.side;
      this.winCells = line;
      this.over = true;
      this.restartAt = performance.now() + 7000;
      for (const d of this.discs) {
        const on = line.some(([c, r]) => c === d.col && r === d.row);
        if (!on) { d.mesh.material.color.multiplyScalar(0.42); }
      }
      const who = this.twoPlayer
        ? (move.side === RED ? "PLAYER 1 WINS" : "PLAYER 2 WINS")
        : (move.side === RED ? "YOU WIN!" : "COMPUTER WINS");
      this.ctx.ui.toast(who, SIDE_NAME[move.side] + " gets four in a row", 7000);
      sfx.cheer(move.side === RED ? 1 : 0.3);
      this.ctx.net.buzz(0, 260);
    } else if (this._full(this.board)) {
      this.over = true;
      this.restartAt = performance.now() + 6000;
      this.ctx.ui.toast("DRAW", "the board is full", 6000);
      sfx.point(false);
    } else {
      this.turn = other(this.turn);
      this.hover.material.color.setHex(DISC_COLOR[this.turn]);
      if (!this._isHuman(this.turn)) {
        this.aiThinkAt = performance.now() + 550;
      }
      sfx.pinHit(0.3);
    }
    this._syncHud();
  }

  // ------------------------------------------------------------ update

  update(dt, time) {
    if (this.falling) { this._fall(dt); }

    if (!this.over && !this.falling) {
      if (this._isHuman(this.turn)) {
        this._aimColumn(dt);
      } else if (this.aiThinkAt && performance.now() > this.aiThinkAt) {
        this.aiThinkAt = 0;
        const col = this._bestMove(this.board, this.turn);
        this.col = col;
        this.smoothCol = col;
        this._play(col);
      }
    }

    if (this.over && this.restartAt && performance.now() > this.restartAt) {
      this.restartAt = 0;
      this.enter();
    }

    // hovering disc follows the chosen column
    const x = this.originX + this.smoothCol * CELL;
    this.hover.position.x = damp(this.hover.position.x, x, 12, dt);
    this.hover.position.y = this.originY + ROWS * CELL - CELL / 2 + 1.1
      + Math.sin(time * 3) * 0.06;
    this.hover.visible = !this.over && !this.falling;
    this.colGlow.visible = this.hover.visible;
    this.colGlow.position.x = this.hover.position.x;
    this.colGlow.position.y = this.originY + (ROWS - 1) * CELL / 2;

    // winning discs pulse
    if (this.winCells) {
      const pulse = 1 + Math.sin(time * 7) * 0.08;
      for (const d of this.discs) {
        const on = this.winCells.some(([c, r]) => c === d.col && r === d.row);
        if (on) { d.mesh.scale.setScalar(pulse); }
      }
    }

    this.ctx.ui.prompt(this.over ? ""
      : this._isHuman(this.turn)
        ? (this.twoPlayer
          ? (this.turn === RED ? "Player 1 (red) to play" : "Player 2 (yellow) to play")
          : "Tilt to choose a column, press to drop")
        : "Computer is thinking…");
  }

  _aimColumn(dt) {
    const seat = this.turn === RED ? 0 : 1;
    const c = this.ctx.seat(seat) || this.ctx.seat(0);
    if (!c) { return; }
    const want = clamp((c.aim * 0.5 + 0.5) * (COLS - 1), 0, COLS - 1);
    this.smoothCol = damp(this.smoothCol, want, 10, dt);
    const nearest = Math.round(this.smoothCol);
    if (nearest !== this.col) {
      this.col = nearest;
      sfx.move();
    }
  }

  _fall(dt) {
    const f = this.falling;
    f.vy -= 34 * dt;
    f.mesh.position.y += f.vy * dt;
    if (f.mesh.position.y <= f.targetY) {
      f.mesh.position.y = f.targetY;
      if (f.bounces < 1 && Math.abs(f.vy) > 4) {
        f.bounces++;
        f.vy = -f.vy * 0.22;
      } else {
        this.falling = null;
        this._settled(f);
      }
    }
  }

  _syncHud() {
    const p1 = this.twoPlayer ? "P1" : "YOU";
    const p2 = this.twoPlayer ? "P2" : "CPU";
    const turnLabel = this.over
      ? (this.winner ? SIDE_NAME[this.winner] + " wins" : "Draw")
      : SIDE_NAME[this.turn] + " to play";
    const chip = (side, label) =>
      '<span class="c4chip' + (this.turn === side && !this.over ? " on" : "")
      + '" style="--c:#' + DISC_COLOR[side].toString(16).padStart(6, "0") + '">'
      + '<i></i>' + label + '</span>';
    this.ctx.ui.hud(
      '<div class="hudRow">' + chip(RED, p1) + chip(YELLOW, p2) + '</div>'
      + '<div class="hudSub">' + turnLabel + '</div>'
    );
  }
}

function other(side) { return side === RED ? YELLOW : RED; }
