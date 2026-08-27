/*
 * Chess.
 *
 * Tilt the phone to slide the cursor around the board, press to pick up a
 * piece, press again on a highlighted square to move it. Two phones play each
 * other; with one phone you are white and black is searched three ply deep.
 *
 * All the rules live in chess-rules.js, which is verified with perft. This
 * file is only the board, the pieces and the input.
 */

import * as THREE from "../../lib/three.module.js";
import { addLights, skyDome, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";
import * as R from "./chess-rules.js";

const CELL = 1.1;
const AI_DEPTH = 3;
const LIGHT_SQ = 0xe8d7b5;
const DARK_SQ = 0x9c6b43;
const WHITE_PIECE = 0xf2ebdc;
const BLACK_PIECE = 0x2b2b33;

const NAMES = { 1: "Pawn", 2: "Knight", 3: "Bishop", 4: "Rook", 5: "Queen", 6: "King" };

export class ChessGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Chess";
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
    scene.add(skyDome(0x1a2438, 0x63708c));
    addLights(scene, { sky: 0xd8e4f8, ground: 0x3a3020, ambient: 1.0, sun: 1.3,
                       shadowRange: 9 });

    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(11, 11, 0.5, 44),
      new THREE.MeshStandardMaterial({ color: 0x2a2b3a, roughness: 0.9 })
    );
    table.position.y = -0.5;
    table.receiveShadow = true;
    scene.add(table);

    // frame
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(CELL * 8 + 0.9, 0.24, CELL * 8 + 0.9),
      new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 0.7 })
    );
    frame.receiveShadow = true;
    scene.add(frame);

    const squares = new THREE.Group();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const light = (f + r) % 2 === 1;
        const sq = new THREE.Mesh(
          new THREE.BoxGeometry(CELL, 0.12, CELL),
          new THREE.MeshStandardMaterial({
            color: light ? LIGHT_SQ : DARK_SQ, roughness: 0.75,
          })
        );
        const p = this._squarePos(f + r * 8);
        sq.position.set(p.x, 0.06, p.z);
        sq.receiveShadow = true;
        squares.add(sq);
      }
    }
    scene.add(squares);

    // cursor ring
    this.cursor = new THREE.Mesh(
      new THREE.TorusGeometry(CELL * 0.44, 0.045, 8, 24),
      new THREE.MeshStandardMaterial({ color: 0x7fe3ff, emissive: 0x14556b })
    );
    this.cursor.rotation.x = -Math.PI / 2;
    this.cursor.position.y = 0.14;
    scene.add(this.cursor);

    // highlight under the piece you have picked up
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
    const f = R.fileOf(sq), r = R.rankOf(sq);
    return new THREE.Vector3((f - 3.5) * CELL, 0, (3.5 - r) * CELL);
  }

  // ------------------------------------------------------------ pieces

  _makePiece(type, color) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: color === R.WHITE ? WHITE_PIECE : BLACK_PIECE,
      roughness: color === R.WHITE ? 0.5 : 0.55,
      metalness: 0.12,
    });
    /** Build a mesh from a geometry, sit it at height y, and attach it. */
    const add = (geo, y) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = y;
      mesh.castShadow = true;
      g.add(mesh);
      return mesh;
    };

    // every piece stands on the same turned base
    add(new THREE.CylinderGeometry(0.3, 0.34, 0.12, 18), 0.06);
    add(new THREE.CylinderGeometry(0.22, 0.3, 0.08, 18), 0.16);

    switch (type) {
      case R.PAWN:
        add(new THREE.CylinderGeometry(0.13, 0.2, 0.26, 14), 0.33);
        add(new THREE.SphereGeometry(0.17, 14, 12), 0.6);
        break;

      case R.ROOK: {
        add(new THREE.CylinderGeometry(0.2, 0.24, 0.46, 14), 0.43);
        add(new THREE.CylinderGeometry(0.26, 0.24, 0.14, 14), 0.73);
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          const c = add(new THREE.BoxGeometry(0.11, 0.16, 0.11), 0.86);
          c.position.x = Math.cos(a) * 0.17;
          c.position.z = Math.sin(a) * 0.17;
        }
        break;
      }

      case R.KNIGHT: {
        add(new THREE.CylinderGeometry(0.17, 0.22, 0.3, 14), 0.35);
        const neck = add(new THREE.BoxGeometry(0.22, 0.42, 0.2), 0.68);
        neck.position.z = -0.03;
        neck.rotation.x = -0.32;
        const head = add(new THREE.BoxGeometry(0.2, 0.2, 0.4), 0.9);
        head.position.z = 0.08;
        head.rotation.x = 0.18;
        add(new THREE.ConeGeometry(0.06, 0.16, 6), 1.03).position.z = -0.03;
        break;
      }

      case R.BISHOP:
        add(new THREE.CylinderGeometry(0.14, 0.22, 0.4, 14), 0.4);
        add(new THREE.SphereGeometry(0.19, 14, 12), 0.72);
        add(new THREE.ConeGeometry(0.09, 0.18, 10), 0.94);
        break;

      case R.QUEEN: {
        add(new THREE.CylinderGeometry(0.16, 0.24, 0.52, 16), 0.46);
        add(new THREE.TorusGeometry(0.2, 0.05, 8, 18), 0.78).rotation.x = Math.PI / 2;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const s = add(new THREE.SphereGeometry(0.055, 8, 6), 0.9);
          s.position.x = Math.cos(a) * 0.19;
          s.position.z = Math.sin(a) * 0.19;
        }
        add(new THREE.SphereGeometry(0.08, 10, 8), 0.98);
        break;
      }

      case R.KING:
        add(new THREE.CylinderGeometry(0.17, 0.25, 0.58, 16), 0.49);
        add(new THREE.TorusGeometry(0.21, 0.05, 8, 18), 0.82).rotation.x = Math.PI / 2;
        add(new THREE.BoxGeometry(0.08, 0.28, 0.08), 1.02);
        add(new THREE.BoxGeometry(0.22, 0.08, 0.08), 1.06);
        break;

      default:
        break;
    }
    return g;
  }

  _rebuildPieces() {
    for (const m of this.pieceMeshes) { this.scene.remove(m); }
    this.pieceMeshes = [];
    for (let sq = 0; sq < 64; sq++) {
      const piece = this.state.board[sq];
      if (piece === R.EMPTY) { continue; }
      const mesh = this._makePiece(R.typeOf(piece), R.colorOf(piece));
      const p = this._squarePos(sq);
      mesh.position.set(p.x, 0.12, p.z);
      if (R.colorOf(piece) === R.BLACK) { mesh.rotation.y = Math.PI; }
      mesh.userData.square = sq;
      this.scene.add(mesh);
      this.pieceMeshes.push(mesh);
    }
  }

  _clearMarkers() {
    for (const m of this.markers) { this.scene.remove(m); }
    this.markers = [];
  }

  _showMoveMarkers() {
    this._clearMarkers();
    if (this.selected === null) { return; }
    for (const move of this.legal) {
      if (move.from !== this.selected) { continue; }
      const capture = this.state.board[move.to] !== R.EMPTY || move.enPassant;
      const geo = capture
        ? new THREE.TorusGeometry(CELL * 0.4, 0.05, 8, 20)
        : new THREE.CylinderGeometry(0.16, 0.16, 0.04, 16);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: capture ? 0xff7a6b : 0x59e39b, transparent: true, opacity: 0.8,
      }));
      if (capture) { mesh.rotation.x = -Math.PI / 2; }
      const p = this._squarePos(move.to);
      mesh.position.set(p.x, 0.15, p.z);
      this.scene.add(mesh);
      this.markers.push(mesh);
    }
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    this.twoPlayer = this.ctx.humanCount() >= 2;
    this.state = R.initialPosition();
    this.legal = R.legalMoves(this.state);
    this.selected = null;
    this.cursorSq = 12;               // e2, a sensible place to start
    this.smoothF = R.fileOf(this.cursorSq);
    this.smoothR = R.rankOf(this.cursorSq);
    this.over = false;
    this.result = null;
    this.lastMove = null;
    this.captured = { 1: [], [-1]: [] };
    this.aiThinkAt = 0;
    this.restartAt = 0;
    this.history = [];

    this._rebuildPieces();
    this._clearMarkers();
    this._brief();
    this._syncHud();
    this.ctx.ui.toast("CHESS",
      this.twoPlayer ? "Player 1 is white" : "You are white", 1900);
  }

  exit() { }

  _brief() {
    const hint = "Tilt to move the cursor, press to pick up and press again to move.";
    for (let i = 0; i < (this.twoPlayer ? 2 : 1); i++) {
      const c = this.ctx.seat(i);
      if (!c) { continue; }
      this.ctx.net.mode(c.pid,
        this.twoPlayer ? "Chess - " + (i === 0 ? "White" : "Black") : "Chess",
        hint, "MOVE", "Press to select, press again to move");
    }
  }

  _sideOf(pid) {
    const seat = this.ctx.seatOf(pid);
    if (seat === 0 || seat === -1) { return R.WHITE; }
    if (seat === 1 && this.twoPlayer) { return R.BLACK; }
    return null;
  }

  _isHuman(color) {
    return color === R.WHITE || this.twoPlayer;
  }

  // ------------------------------------------------------------ input

  onButton(down, pid) {
    if (!down || this.over) { return; }
    const side = this._sideOf(pid);
    if (side === null || side !== this.state.turn) { return; }
    if (!this._isHuman(this.state.turn)) { return; }
    this._press(this.cursorSq);
  }

  onSwing() { /* the button does everything */ }

  _press(sq) {
    const piece = this.state.board[sq];

    // picking up, or swapping to another of your own pieces
    if (piece !== R.EMPTY && R.colorOf(piece) === this.state.turn) {
      if (this.selected === sq) {
        this.selected = null;                  // press again to put it back down
      } else if (this.legal.some(m => m.from === sq)) {
        this.selected = sq;
        sfx.select();
      } else {
        sfx.emptyClick();
        this.ctx.ui.toast("NO LEGAL MOVES", NAMES[R.typeOf(piece)] + " cannot move", 1100);
      }
      this._showMoveMarkers();
      return;
    }

    if (this.selected === null) {
      sfx.emptyClick();
      return;
    }

    // always promote to a queen - the other choices are vanishingly rare and
    // would need another round of input on the phone
    const move = this.legal.find(m => m.from === this.selected && m.to === sq
      && (!m.promo || m.promo === R.QUEEN));
    if (!move) {
      sfx.emptyClick();
      return;
    }
    this._applyMove(move);
  }

  _applyMove(move) {
    const label = R.moveName(this.state, move);
    const taken = move.enPassant
      ? this.state.board[move.to - 8 * this.state.turn]
      : this.state.board[move.to];
    const mover = this.state.turn;

    this.state = R.makeMove(this.state, move);
    if (taken !== R.EMPTY) {
      this.captured[mover].push(R.typeOf(taken));
      sfx.pinHit(0.6);
    } else {
      sfx.tone(430, 0.05, { type: "square", gain: 0.09 });
    }

    this.selected = null;
    this.lastMove = move;
    this.history.push(label);
    this._rebuildPieces();
    this._clearMarkers();

    this.legal = R.legalMoves(this.state);
    const result = R.gameResult(this.state);
    if (result.over) {
      this.over = true;
      this.result = result;
      this.restartAt = performance.now() + 12000;
      if (result.kind === "checkmate") {
        const who = result.winner === R.WHITE ? "WHITE" : "BLACK";
        const humanWon = this.twoPlayer || result.winner === R.WHITE;
        this.ctx.ui.toast("CHECKMATE", who + " wins", 12000);
        sfx.cheer(humanWon ? 1 : 0.3);
      } else {
        this.ctx.ui.toast("DRAW", result.reason, 12000);
        sfx.point(false);
      }
      this.ctx.net.buzz(0, 250);
    } else if (R.inCheck(this.state, this.state.turn)) {
      this.ctx.ui.toast("CHECK", "", 1200);
      sfx.point(false);
      this.ctx.net.buzz(0, 90);
    }

    if (!this.over && !this._isHuman(this.state.turn)) {
      this.aiThinkAt = performance.now() + 350;
    }
    this._syncHud();
  }

  // ------------------------------------------------------------ update

  update(dt, time) {
    if (!this.over && this._isHuman(this.state.turn)) {
      this._moveCursor(dt);
    }

    if (this.aiThinkAt && performance.now() > this.aiThinkAt) {
      this.aiThinkAt = 0;
      const move = R.bestMove(this.state, AI_DEPTH);
      if (move) { this._applyMove(move); }
    }

    if (this.over && this.restartAt && performance.now() > this.restartAt) {
      this.restartAt = 0;
      this.enter();
      return;
    }

    // cursor and highlights
    const p = this._squarePos(this.cursorSq);
    this.cursor.position.x = damp(this.cursor.position.x, p.x, 14, dt);
    this.cursor.position.z = damp(this.cursor.position.z, p.z, 14, dt);
    this.cursor.position.y = 0.16 + Math.sin(time * 4) * 0.03;
    this.cursor.visible = !this.over && this._isHuman(this.state.turn);

    this.selectGlow.visible = this.selected !== null;
    if (this.selected !== null) {
      const sp = this._squarePos(this.selected);
      this.selectGlow.position.x = sp.x;
      this.selectGlow.position.z = sp.z;
    }

    // lift the piece you are holding
    for (const mesh of this.pieceMeshes) {
      const lifted = mesh.userData.square === this.selected;
      mesh.position.y = damp(mesh.position.y, lifted ? 0.42 : 0.12, 12, dt);
    }

    this._camera(dt);
    this.ctx.ui.prompt(this.over ? ""
      : !this._isHuman(this.state.turn) ? "Black is thinking…"
        : this.selected === null
          ? (this.twoPlayer
            ? (this.state.turn === R.WHITE ? "White: pick a piece" : "Black: pick a piece")
            : "Tilt to a piece and press to pick it up")
          : "Press on a highlighted square");
  }

  _moveCursor(dt) {
    const seat = this.state.turn === R.WHITE ? 0 : 1;
    const c = this.ctx.seat(seat) || this.ctx.seat(0);
    if (!c) { return; }
    // black sits at the other end, so their axes are mirrored
    const flip = this.twoPlayer && this.state.turn === R.BLACK;
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
    // in a two-player game the board turns to face whoever is to move
    const black = this.twoPlayer && this.state.turn === R.BLACK && !this.over;
    const targetZ = black ? -8.6 : 8.6;
    this.camera.position.x = damp(this.camera.position.x, 0, 4, dt);
    this.camera.position.y = damp(this.camera.position.y, 9.2, 4, dt);
    this.camera.position.z = damp(this.camera.position.z, targetZ, 3.5, dt);
    this.camera.lookAt(0, 0, 0);
  }

  _syncHud() {
    const glyph = { 1: "♟", 2: "♞", 3: "♝", 4: "♜", 5: "♛" };
    const taken = (color) => this.captured[color].sort((a, b) => b - a)
      .map(t => glyph[t] || "").join("");
    const white = this.twoPlayer ? "P1 WHITE" : "YOU";
    const black = this.twoPlayer ? "P2 BLACK" : "CPU";
    const turnText = this.over
      ? (this.result.kind === "checkmate"
        ? (this.result.winner === R.WHITE ? "White wins by checkmate" : "Black wins by checkmate")
        : "Draw - " + this.result.reason)
      : (this.state.turn === R.WHITE ? "White to move" : "Black to move")
        + (R.inCheck(this.state, this.state.turn) ? "  &middot;  CHECK" : "");
    const last = this.history.length
      ? "  &middot;  " + Math.ceil(this.history.length / 2) + ". "
        + this.history[this.history.length - 1] : "";

    this.ctx.ui.hud(
      '<div class="hudRow chessRow">'
      + '<span class="tag blue">' + white + '</span>'
      + '<span class="taken">' + taken(R.WHITE) + '</span>'
      + '<span class="sep">vs</span>'
      + '<span class="taken">' + taken(R.BLACK) + '</span>'
      + '<span class="tag red">' + black + '</span>'
      + '</div>'
      + '<div class="hudSub">' + turnText + last + '</div>'
    );
  }
}
