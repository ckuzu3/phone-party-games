/*
 * Dame (draughts).
 *
 * Tilt the phone to slide the cursor, press to pick a piece up, press again on
 * a highlighted square to move it. Captures are compulsory, so when a jump is
 * available the quiet moves simply are not offered.
 *
 * A multi-jump is played one hop at a time: after each landing the remaining
 * options are shown again, and the move is only committed once the chain has
 * nowhere left to go. The board is not changed until then, so the pieces you
 * are about to take are merely hidden while you work through the sequence.
 *
 * All rules live in dame-rules.js.
 */

import * as THREE from "../../lib/three.module.js";
import { addLights, skyDome, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";
import * as D from "./dame-rules.js";

const CELL = 1.1;
const AI_DEPTH = 7;          // draughts branches narrowly, so this costs ~75ms
const LIGHT_SQ = 0xe6d3ae;
const DARK_SQ = 0x7a4a2c;
const WHITE_PIECE = 0xf4efe2;
const BLACK_PIECE = 0x24242c;

export class DameGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Dame";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 200);
    this.cameras = [this.camera];
    this.pieceMeshes = [];
    this.markers = [];
    this._build();
  }

  // ------------------------------------------------------------ scenery

  _build() {
    const scene = this.scene;
    scene.add(skyDome(0x1c2030, 0x6b7284));
    addLights(scene, { sky: 0xdae6f8, ground: 0x3a2c1c, ambient: 1.0, sun: 1.3,
                       shadowRange: 9 });

    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(11, 11, 0.5, 44),
      new THREE.MeshStandardMaterial({ color: 0x2d2a34, roughness: 0.9 })
    );
    table.position.y = -0.5;
    table.receiveShadow = true;
    scene.add(table);

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(CELL * 8 + 0.9, 0.24, CELL * 8 + 0.9),
      new THREE.MeshStandardMaterial({ color: 0x53381f, roughness: 0.7 })
    );
    frame.receiveShadow = true;
    scene.add(frame);

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const sq = f + r * 8;
        const playable = D.isPlayable(sq);
        const tile = new THREE.Mesh(
          new THREE.BoxGeometry(CELL, 0.12, CELL),
          new THREE.MeshStandardMaterial({
            color: playable ? DARK_SQ : LIGHT_SQ, roughness: 0.78,
          })
        );
        const p = this._squarePos(sq);
        tile.position.set(p.x, 0.06, p.z);
        tile.receiveShadow = true;
        scene.add(tile);
      }
    }

    this.cursor = new THREE.Mesh(
      new THREE.TorusGeometry(CELL * 0.44, 0.045, 8, 24),
      new THREE.MeshStandardMaterial({ color: 0x7fe3ff, emissive: 0x14556b })
    );
    this.cursor.rotation.x = -Math.PI / 2;
    this.cursor.position.y = 0.14;
    scene.add(this.cursor);

    this.selectGlow = new THREE.Mesh(
      new THREE.BoxGeometry(CELL * 0.98, 0.02, CELL * 0.98),
      new THREE.MeshBasicMaterial({ color: 0x59e39b, transparent: true, opacity: 0.55 })
    );
    this.selectGlow.position.y = 0.13;
    this.selectGlow.visible = false;
    scene.add(this.selectGlow);

    this.camera.position.set(0, 9.2, 8.6);
    this.camera.lookAt(0, 0, 0);
  }

  _squarePos(sq) {
    return new THREE.Vector3(
      (D.fileOf(sq) - 3.5) * CELL, 0, (3.5 - D.rankOf(sq)) * CELL);
  }

  // ------------------------------------------------------------ pieces

  _makePiece(type, color) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: color === D.WHITE ? WHITE_PIECE : BLACK_PIECE,
      roughness: 0.45, metalness: 0.15,
    });
    const disc = (y, r) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.14, 24), mat);
      m.position.y = y;
      m.castShadow = true;
      g.add(m);
      return m;
    };
    disc(0.09, 0.38);
    // a groove around the rim, as on a real draught
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.025, 8, 24), mat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.09;
    g.add(rim);

    if (type === D.KING) {
      disc(0.23, 0.38);
      const crown = new THREE.Mesh(
        new THREE.TorusGeometry(0.16, 0.04, 8, 20),
        new THREE.MeshStandardMaterial({
          color: 0xffd166, roughness: 0.35, metalness: 0.55,
        })
      );
      crown.rotation.x = Math.PI / 2;
      crown.position.y = 0.32;
      crown.castShadow = true;
      g.add(crown);
    }
    return g;
  }

  _rebuildPieces() {
    for (const m of this.pieceMeshes) { this.scene.remove(m); }
    this.pieceMeshes = [];
    for (let sq = 0; sq < 64; sq++) {
      const piece = this.state.board[sq];
      if (piece === D.EMPTY) { continue; }
      const mesh = this._makePiece(D.typeOf(piece), D.colorOf(piece));
      const p = this._squarePos(sq);
      mesh.position.set(p.x, 0.12, p.z);
      mesh.userData.square = sq;
      this.scene.add(mesh);
      this.pieceMeshes.push(mesh);
    }
  }

  _clearMarkers() {
    for (const m of this.markers) { this.scene.remove(m); }
    this.markers = [];
  }

  /** Highlight wherever the held piece may go next. */
  _showMarkers() {
    this._clearMarkers();
    if (this.selected === null) { return; }
    const seen = new Set();
    for (const move of this._candidates()) {
      const next = move.path[this.partial.length];
      if (next === undefined || seen.has(next)) { continue; }
      seen.add(next);
      const capture = move.captures.length > 0;
      const geo = capture
        ? new THREE.TorusGeometry(CELL * 0.4, 0.05, 8, 20)
        : new THREE.CylinderGeometry(0.16, 0.16, 0.04, 16);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: capture ? 0xff7a6b : 0x59e39b, transparent: true, opacity: 0.85,
      }));
      if (capture) { mesh.rotation.x = -Math.PI / 2; }
      const p = this._squarePos(next);
      mesh.position.set(p.x, 0.16, p.z);
      this.scene.add(mesh);
      this.markers.push(mesh);
    }
  }

  /** Legal moves still consistent with the hops taken so far. */
  _candidates() {
    if (this.selected === null) { return []; }
    return this.legal.filter(m => {
      if (m.from !== this.selected) { return false; }
      for (let i = 0; i < this.partial.length; i++) {
        if (m.path[i] !== this.partial[i]) { return false; }
      }
      return true;
    });
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    this.twoPlayer = this.ctx.humanCount() >= 2;
    this.state = D.initialPosition();
    this.legal = D.legalMoves(this.state);
    this.selected = null;
    this.partial = [];
    this.cursorSq = 16;
    this.smoothF = D.fileOf(this.cursorSq);
    this.smoothR = D.rankOf(this.cursorSq);
    this.over = false;
    this.result = null;
    this.aiThinkAt = 0;
    this.restartAt = 0;
    this.history = [];
    this.taken = { 1: 0, [-1]: 0 };

    this._rebuildPieces();
    this._clearMarkers();
    this._brief();
    this._syncHud();
    this.ctx.ui.toast("DAME",
      this.twoPlayer ? "Player 1 is light" : "You are light  ·  captures are compulsory", 2200);
  }

  exit() { }

  _brief() {
    const hint = "Tilt to the piece, press to pick up, press again to move. "
      + "Jumps are compulsory.";
    for (let i = 0; i < (this.twoPlayer ? 2 : 1); i++) {
      const c = this.ctx.seat(i);
      if (!c) { continue; }
      this.ctx.net.mode(c.pid,
        this.twoPlayer ? "Dame - " + (i === 0 ? "Light" : "Dark") : "Dame",
        hint, "MOVE", "Press to select, press again to move");
    }
  }

  _sideOf(pid) {
    const seat = this.ctx.seatOf(pid);
    if (seat === 0 || seat === -1) { return D.WHITE; }
    if (seat === 1 && this.twoPlayer) { return D.BLACK; }
    return null;
  }

  _isHuman(color) {
    return color === D.WHITE || this.twoPlayer;
  }

  // ------------------------------------------------------------ input

  onButton(down, pid) {
    if (!down || this.over) { return; }
    const side = this._sideOf(pid);
    if (side === null || side !== this.state.turn) { return; }
    if (!this._isHuman(this.state.turn)) { return; }
    this._press(this.cursorSq);
  }

  onSwing() { }

  _press(sq) {
    // partway through a jump chain the only choices are the next hops
    if (this.selected !== null && this.partial.length > 0) {
      this._advance(sq);
      return;
    }

    const piece = this.state.board[sq];
    if (piece !== D.EMPTY && D.colorOf(piece) === this.state.turn) {
      if (this.selected === sq) {
        this.selected = null;
        this.partial = [];
      } else if (this.legal.some(m => m.from === sq)) {
        this.selected = sq;
        this.partial = [];
        sfx.select();
      } else {
        sfx.emptyClick();
        this.ctx.ui.toast("NOT THIS ONE",
          this.legal.some(m => m.captures.length)
            ? "a jump is available elsewhere" : "that piece cannot move", 1300);
      }
      this._showMarkers();
      return;
    }

    if (this.selected === null) { sfx.emptyClick(); return; }
    this._advance(sq);
  }

  /** Take one hop of the chosen move, finishing it when the path runs out. */
  _advance(sq) {
    const candidates = this._candidates();
    const matching = candidates.filter(m => m.path[this.partial.length] === sq);
    if (matching.length === 0) {
      sfx.emptyClick();
      return;
    }

    this.partial.push(sq);
    const done = matching.find(m => m.path.length === this.partial.length);
    if (done) {
      this._applyMove(done);
      return;
    }
    // more jumps to come - keep hold of the piece and offer the next hops
    sfx.pinHit(0.45);
    this.ctx.net.buzz(0, 30, false);
    this._showMarkers();
  }

  _applyMove(move) {
    const label = D.moveName(move);
    const mover = this.state.turn;
    this.taken[mover] += move.captures.length;

    this.state = D.makeMove(this.state, move);
    if (move.captures.length) { sfx.pinHit(0.8); } else {
      sfx.tone(430, 0.05, { type: "square", gain: 0.09 });
    }
    if (this.state.promoted) {
      sfx.point(true);
      this.ctx.ui.toast("DAME!", "that piece is crowned", 1500);
    }

    this.selected = null;
    this.partial = [];
    this.history.push(label);
    this._rebuildPieces();
    this._clearMarkers();

    this.legal = D.legalMoves(this.state);
    const result = D.gameResult(this.state);
    if (result.over) {
      this.over = true;
      this.result = result;
      this.restartAt = performance.now() + 11000;
      if (result.kind === "win") {
        const light = result.winner === D.WHITE;
        const title = this.twoPlayer
          ? (light ? "PLAYER 1 WINS" : "PLAYER 2 WINS")
          : (light ? "YOU WIN!" : "COMPUTER WINS");
        this.ctx.ui.toast(title,
          D.countPieces(this.state.board, -result.winner).total === 0
            ? "every piece captured" : "no moves left", 11000);
        sfx.cheer(light ? 1 : 0.3);
      } else {
        this.ctx.ui.toast("DRAW", result.reason, 11000);
        sfx.point(false);
      }
      this.ctx.net.buzz(0, 250);
    }

    if (!this.over && !this._isHuman(this.state.turn)) {
      this.aiThinkAt = performance.now() + 320;
    }
    this._syncHud();
  }

  // ------------------------------------------------------------ update

  update(dt, time) {
    if (!this.over && this._isHuman(this.state.turn)) { this._moveCursor(dt); }

    if (this.aiThinkAt && performance.now() > this.aiThinkAt) {
      this.aiThinkAt = 0;
      const move = D.bestMove(this.state, AI_DEPTH);
      if (move) { this._applyMove(move); }
    }

    if (this.over && this.restartAt && performance.now() > this.restartAt) {
      this.restartAt = 0;
      this.enter();
      return;
    }

    const p = this._squarePos(this.cursorSq);
    this.cursor.position.x = damp(this.cursor.position.x, p.x, 14, dt);
    this.cursor.position.z = damp(this.cursor.position.z, p.z, 14, dt);
    this.cursor.position.y = 0.16 + Math.sin(time * 4) * 0.03;
    this.cursor.visible = !this.over && this._isHuman(this.state.turn);

    // where the held piece currently sits along its chain
    const holding = this.selected !== null;
    const at = holding
      ? (this.partial.length ? this.partial[this.partial.length - 1] : this.selected)
      : null;
    this.selectGlow.visible = holding;
    if (holding) {
      const sp = this._squarePos(at);
      this.selectGlow.position.x = sp.x;
      this.selectGlow.position.z = sp.z;
    }

    // pieces about to be captured fade out while the chain is being played
    const doomed = new Set();
    if (holding && this.partial.length) {
      for (const m of this._candidates()) {
        if (m.path.length < this.partial.length) { continue; }
        for (let i = 0; i < this.partial.length; i++) {
          if (m.captures[i] !== undefined) { doomed.add(m.captures[i]); }
        }
        break;
      }
    }

    for (const mesh of this.pieceMeshes) {
      const sq = mesh.userData.square;
      if (sq === this.selected && holding) {
        const target = this._squarePos(at);
        mesh.position.x = damp(mesh.position.x, target.x, 13, dt);
        mesh.position.z = damp(mesh.position.z, target.z, 13, dt);
        mesh.position.y = damp(mesh.position.y, 0.42, 12, dt);
      } else {
        mesh.position.y = damp(mesh.position.y, 0.12, 12, dt);
      }
      mesh.visible = !doomed.has(sq);
    }

    this._camera(dt);
    this.ctx.ui.prompt(this.over ? ""
      : !this._isHuman(this.state.turn) ? "Dark is thinking…"
        : this.partial.length ? "Keep jumping - press the next square"
          : this.selected === null
            ? (this.legal.some(m => m.captures.length)
              ? "A jump is available - you must take it"
              : "Tilt to a piece and press to pick it up")
            : "Press on a highlighted square");
  }

  _moveCursor(dt) {
    const seat = this.state.turn === D.WHITE ? 0 : 1;
    const c = this.ctx.seat(seat) || this.ctx.seat(0);
    if (!c) { return; }
    const flip = this.twoPlayer && this.state.turn === D.BLACK;
    const aim = flip ? -c.aim : c.aim;
    const lean = flip ? -c.lean : c.lean;
    const wantF = clamp((aim * 0.5 + 0.5) * 7, 0, 7);
    const wantR = clamp((-lean * 0.5 + 0.5) * 7, 0, 7);
    this.smoothF = damp(this.smoothF, wantF, 11, dt);
    this.smoothR = damp(this.smoothR, wantR, 11, dt);
    const sq = Math.round(this.smoothR) * 8 + Math.round(this.smoothF);
    if (sq !== this.cursorSq) {
      this.cursorSq = sq;
      sfx.move();
    }
  }

  _camera(dt) {
    const dark = this.twoPlayer && this.state.turn === D.BLACK && !this.over;
    this.camera.position.x = damp(this.camera.position.x, 0, 4, dt);
    this.camera.position.y = damp(this.camera.position.y, 9.2, 4, dt);
    this.camera.position.z = damp(this.camera.position.z, dark ? -8.6 : 8.6, 3.5, dt);
    this.camera.lookAt(0, 0, 0);
  }

  _syncHud() {
    const light = D.countPieces(this.state.board, D.WHITE);
    const dark = D.countPieces(this.state.board, D.BLACK);
    const p1 = this.twoPlayer ? "P1 LIGHT" : "YOU";
    const p2 = this.twoPlayer ? "P2 DARK" : "CPU";
    const count = (c) => c.total + (c.kings ? ' <i>+' + c.kings + '&#9819;</i>' : '');
    const turnText = this.over
      ? (this.result.kind === "win"
        ? (this.result.winner === D.WHITE ? "Light wins" : "Dark wins")
        : "Draw - " + this.result.reason)
      : (this.state.turn === D.WHITE ? "Light to move" : "Dark to move")
        + (this.legal.some(m => m.captures.length) ? "  &middot;  must jump" : "");

    this.ctx.ui.hud(
      '<div class="hudRow dameRow">'
      + '<span class="tag blue">' + p1 + '</span>'
      + '<span class="count">' + count(light) + '</span>'
      + '<span class="sep">vs</span>'
      + '<span class="count">' + count(dark) + '</span>'
      + '<span class="tag red">' + p2 + '</span>'
      + '</div>'
      + '<div class="hudSub">' + turnText + '</div>'
    );
  }
}
