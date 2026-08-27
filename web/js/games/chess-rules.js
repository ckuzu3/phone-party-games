/*
 * Chess rules: board state, legal move generation, and a search.
 *
 * Kept apart from the 3D board so the rules can be checked on their own. Move
 * generation is verified with perft - counting the leaves of the move tree to
 * a given depth and comparing against the published totals for known
 * positions, which catches castling, en passant and promotion mistakes that
 * casual play would hide for a long time.
 *
 * Squares are 0..63 with 0 = a1 and 63 = h8, so rank = sq >> 3 and
 * file = sq & 7. White moves up the board (+8).
 */

export const EMPTY = 0;
export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
export const WHITE = 1, BLACK = -1;

// castling rights as bit flags
const WK = 1, WQ = 2, BK = 4, BQ = 8;

const KNIGHT_DIRS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export const fileOf = (sq) => sq & 7;
export const rankOf = (sq) => sq >> 3;
const onBoard = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const sqOf = (f, r) => r * 8 + f;

export function initialPosition() {
  const board = new Int8Array(64);
  const back = [ROOK, KNIGHT, BISHOP, QUEEN, KING, BISHOP, KNIGHT, ROOK];
  for (let f = 0; f < 8; f++) {
    board[sqOf(f, 0)] = back[f];
    board[sqOf(f, 1)] = PAWN;
    board[sqOf(f, 6)] = -PAWN;
    board[sqOf(f, 7)] = -back[f];
  }
  return { board, turn: WHITE, castling: WK | WQ | BK | BQ, ep: -1, halfmove: 0, fullmove: 1 };
}

export function cloneState(s) {
  return {
    board: Int8Array.from(s.board),
    turn: s.turn, castling: s.castling, ep: s.ep,
    halfmove: s.halfmove, fullmove: s.fullmove,
  };
}

export const colorOf = (piece) => (piece > 0 ? WHITE : piece < 0 ? BLACK : 0);
export const typeOf = (piece) => Math.abs(piece);

/** Is `sq` attacked by any piece of `by`? Checked directly, never by recursion. */
export function isAttacked(board, sq, by) {
  const f = fileOf(sq), r = rankOf(sq);

  // pawns: a white pawn on a lower rank attacks diagonally upward
  const pr = r - by;                       // rank the attacking pawn would sit on
  for (const df of [-1, 1]) {
    if (!onBoard(f + df, pr)) { continue; }
    if (board[sqOf(f + df, pr)] === PAWN * by) { return true; }
  }

  for (const [df, dr] of KNIGHT_DIRS) {
    if (!onBoard(f + df, r + dr)) { continue; }
    if (board[sqOf(f + df, r + dr)] === KNIGHT * by) { return true; }
  }

  for (const [df, dr] of KING_DIRS) {
    if (!onBoard(f + df, r + dr)) { continue; }
    if (board[sqOf(f + df, r + dr)] === KING * by) { return true; }
  }

  const slide = (dirs, a, b) => {
    for (const [df, dr] of dirs) {
      let nf = f + df, nr = r + dr;
      while (onBoard(nf, nr)) {
        const p = board[sqOf(nf, nr)];
        if (p !== EMPTY) {
          if (colorOf(p) === by) {
            const t = typeOf(p);
            if (t === a || t === b) { return true; }
          }
          break;
        }
        nf += df; nr += dr;
      }
    }
    return false;
  };
  if (slide(ROOK_DIRS, ROOK, QUEEN)) { return true; }
  if (slide(BISHOP_DIRS, BISHOP, QUEEN)) { return true; }
  return false;
}

export function kingSquare(board, color) {
  for (let sq = 0; sq < 64; sq++) {
    if (board[sq] === KING * color) { return sq; }
  }
  return -1;
}

export function inCheck(state, color) {
  const k = kingSquare(state.board, color);
  return k >= 0 && isAttacked(state.board, k, -color);
}

/** Every pseudo-legal move; king-safety is filtered afterwards. */
function pseudoMoves(state) {
  const { board, turn } = state;
  const moves = [];
  const add = (from, to, extra) => moves.push(Object.assign({ from, to }, extra));

  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (piece === EMPTY || colorOf(piece) !== turn) { continue; }
    const t = typeOf(piece);
    const f = fileOf(from), r = rankOf(from);

    if (t === PAWN) {
      const dir = turn;
      const startRank = turn === WHITE ? 1 : 6;
      const lastRank = turn === WHITE ? 7 : 0;
      const oneR = r + dir;
      if (onBoard(f, oneR) && board[sqOf(f, oneR)] === EMPTY) {
        const to = sqOf(f, oneR);
        if (oneR === lastRank) {
          for (const promo of [QUEEN, ROOK, BISHOP, KNIGHT]) { add(from, to, { promo }); }
        } else {
          add(from, to);
          const twoR = r + dir * 2;
          if (r === startRank && board[sqOf(f, twoR)] === EMPTY) {
            add(from, sqOf(f, twoR), { double: true });
          }
        }
      }
      for (const df of [-1, 1]) {
        const nf = f + df;
        if (!onBoard(nf, oneR)) { continue; }
        const to = sqOf(nf, oneR);
        const target = board[to];
        if (target !== EMPTY && colorOf(target) === -turn) {
          if (oneR === lastRank) {
            for (const promo of [QUEEN, ROOK, BISHOP, KNIGHT]) { add(from, to, { promo }); }
          } else { add(from, to); }
        } else if (to === state.ep) {
          add(from, to, { enPassant: true });
        }
      }
      continue;
    }

    if (t === KNIGHT || t === KING) {
      const dirs = t === KNIGHT ? KNIGHT_DIRS : KING_DIRS;
      for (const [df, dr] of dirs) {
        const nf = f + df, nr = r + dr;
        if (!onBoard(nf, nr)) { continue; }
        const to = sqOf(nf, nr);
        if (board[to] === EMPTY || colorOf(board[to]) === -turn) { add(from, to); }
      }
      if (t === KING) {
        // castling: rights, empty squares, and the king may not start in,
        // pass through, or land on an attacked square
        const home = turn === WHITE ? 4 : 60;
        if (from === home && !isAttacked(board, home, -turn)) {
          const kSide = turn === WHITE ? WK : BK;
          const qSide = turn === WHITE ? WQ : BQ;
          if ((state.castling & kSide)
              && board[home + 1] === EMPTY && board[home + 2] === EMPTY
              && !isAttacked(board, home + 1, -turn)
              && !isAttacked(board, home + 2, -turn)) {
            add(from, home + 2, { castle: "K" });
          }
          if ((state.castling & qSide)
              && board[home - 1] === EMPTY && board[home - 2] === EMPTY
              && board[home - 3] === EMPTY
              && !isAttacked(board, home - 1, -turn)
              && !isAttacked(board, home - 2, -turn)) {
            add(from, home - 2, { castle: "Q" });
          }
        }
      }
      continue;
    }

    const dirs = t === ROOK ? ROOK_DIRS : t === BISHOP ? BISHOP_DIRS
      : ROOK_DIRS.concat(BISHOP_DIRS);
    for (const [df, dr] of dirs) {
      let nf = f + df, nr = r + dr;
      while (onBoard(nf, nr)) {
        const to = sqOf(nf, nr);
        const target = board[to];
        if (target === EMPTY) { add(from, to); } else {
          if (colorOf(target) === -turn) { add(from, to); }
          break;
        }
        nf += df; nr += dr;
      }
    }
  }
  return moves;
}

/** Apply a move, returning the new state. The caller keeps the old one. */
export function makeMove(state, move) {
  const s = cloneState(state);
  const b = s.board;
  const piece = b[move.from];
  const t = typeOf(piece);
  const captured = move.enPassant
    ? b[move.to - 8 * s.turn]
    : b[move.to];

  b[move.to] = move.promo ? move.promo * s.turn : piece;
  b[move.from] = EMPTY;

  if (move.enPassant) { b[move.to - 8 * s.turn] = EMPTY; }

  if (move.castle) {
    const home = s.turn === WHITE ? 4 : 60;
    if (move.castle === "K") {
      b[home + 1] = b[home + 3];
      b[home + 3] = EMPTY;
    } else {
      b[home - 1] = b[home - 4];
      b[home - 4] = EMPTY;
    }
  }

  // castling rights die when a king or rook leaves, or a rook is captured
  if (t === KING) {
    s.castling &= s.turn === WHITE ? ~(WK | WQ) : ~(BK | BQ);
  }
  const clearRookRight = (sq) => {
    if (sq === 0) { s.castling &= ~WQ; }
    else if (sq === 7) { s.castling &= ~WK; }
    else if (sq === 56) { s.castling &= ~BQ; }
    else if (sq === 63) { s.castling &= ~BK; }
  };
  clearRookRight(move.from);
  clearRookRight(move.to);

  s.ep = move.double ? move.from + 8 * s.turn : -1;
  s.halfmove = (t === PAWN || captured !== EMPTY) ? 0 : s.halfmove + 1;
  if (s.turn === BLACK) { s.fullmove++; }
  s.turn = -s.turn;
  s.captured = captured;
  return s;
}

/** Pseudo-legal moves minus the ones that leave your own king in check. */
export function legalMoves(state) {
  const out = [];
  for (const move of pseudoMoves(state)) {
    const next = makeMove(state, move);
    if (!inCheck(next, state.turn)) { out.push(move); }
  }
  return out;
}

export function gameResult(state) {
  const moves = legalMoves(state);
  if (moves.length > 0) {
    if (state.halfmove >= 100) { return { over: true, kind: "draw", reason: "fifty-move rule" }; }
    return { over: false };
  }
  if (inCheck(state, state.turn)) {
    return { over: true, kind: "checkmate", winner: -state.turn };
  }
  return { over: true, kind: "draw", reason: "stalemate" };
}

/** Count leaf nodes to `depth` - the standard move-generation self-test. */
export function perft(state, depth) {
  if (depth === 0) { return 1; }
  const moves = legalMoves(state);
  if (depth === 1) { return moves.length; }
  let total = 0;
  for (const m of moves) { total += perft(makeMove(state, m), depth - 1); }
  return total;
}

// ---------------------------------------------------------------- the engine

const VALUE = { 1: 100, 2: 320, 3: 330, 4: 500, 5: 900, 6: 20000 };

// piece-square tables, from white's point of view, a1 first
const PST = {
  1: [0, 0, 0, 0, 0, 0, 0, 0,
      5, 10, 10, -20, -20, 10, 10, 5,
      5, -5, -10, 0, 0, -10, -5, 5,
      0, 0, 0, 20, 20, 0, 0, 0,
      5, 5, 10, 25, 25, 10, 5, 5,
      10, 10, 20, 30, 30, 20, 10, 10,
      50, 50, 50, 50, 50, 50, 50, 50,
      0, 0, 0, 0, 0, 0, 0, 0],
  2: [-50, -40, -30, -30, -30, -30, -40, -50,
      -40, -20, 0, 5, 5, 0, -20, -40,
      -30, 5, 10, 15, 15, 10, 5, -30,
      -30, 0, 15, 20, 20, 15, 0, -30,
      -30, 5, 15, 20, 20, 15, 5, -30,
      -30, 0, 10, 15, 15, 10, 0, -30,
      -40, -20, 0, 0, 0, 0, -20, -40,
      -50, -40, -30, -30, -30, -30, -40, -50],
  3: [-20, -10, -10, -10, -10, -10, -10, -20,
      -10, 5, 0, 0, 0, 0, 5, -10,
      -10, 10, 10, 10, 10, 10, 10, -10,
      -10, 0, 10, 10, 10, 10, 0, -10,
      -10, 5, 5, 10, 10, 5, 5, -10,
      -10, 0, 5, 10, 10, 5, 0, -10,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -20, -10, -10, -10, -10, -10, -10, -20],
  4: [0, 0, 0, 5, 5, 0, 0, 0,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      5, 10, 10, 10, 10, 10, 10, 5,
      0, 0, 0, 0, 0, 0, 0, 0],
  5: [-20, -10, -10, -5, -5, -10, -10, -20,
      -10, 0, 5, 0, 0, 0, 0, -10,
      -10, 5, 5, 5, 5, 5, 0, -10,
      0, 0, 5, 5, 5, 5, 0, -5,
      -5, 0, 5, 5, 5, 5, 0, -5,
      -10, 0, 5, 5, 5, 5, 0, -10,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -20, -10, -10, -5, -5, -10, -10, -20],
  6: [20, 30, 10, 0, 0, 10, 30, 20,
      20, 20, 0, 0, 0, 0, 20, 20,
      -10, -20, -20, -20, -20, -20, -20, -10,
      -20, -30, -30, -40, -40, -30, -30, -20,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30],
};

/** Score from the point of view of the side to move. */
function evaluate(state) {
  let score = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = state.board[sq];
    if (p === EMPTY) { continue; }
    const t = typeOf(p);
    const c = colorOf(p);
    const table = PST[t];
    const idx = c === WHITE ? sq : (56 - (sq & ~7)) + (sq & 7);
    score += c * (VALUE[t] + table[idx]);
  }
  return score * state.turn;
}

function orderMoves(state, moves) {
  // try captures first, biggest victim by smallest attacker
  return moves.map(m => {
    const victim = state.board[m.to];
    const attacker = state.board[m.from];
    const score = victim === EMPTY ? 0
      : 1000 + VALUE[typeOf(victim)] - VALUE[typeOf(attacker)] / 10;
    return { m, score: score + (m.promo ? 900 : 0) };
  }).sort((a, b) => b.score - a.score).map(x => x.m);
}

function search(state, depth, alpha, beta) {
  const moves = legalMoves(state);
  if (moves.length === 0) {
    if (inCheck(state, state.turn)) { return -100000 + (10 - depth); }  // prefer later mates
    return 0;
  }
  if (depth === 0) { return evaluate(state); }

  let best = -Infinity;
  for (const m of orderMoves(state, moves)) {
    const score = -search(makeMove(state, m), depth - 1, -beta, -alpha);
    if (score > best) { best = score; }
    if (best > alpha) { alpha = best; }
    if (alpha >= beta) { break; }
  }
  return best;
}

/** Pick a move for the side to move. */
export function bestMove(state, depth) {
  const moves = legalMoves(state);
  if (moves.length === 0) { return null; }
  let best = null;
  let bestScore = -Infinity;
  for (const m of orderMoves(state, moves)) {
    const score = -search(makeMove(state, m), (depth || 3) - 1, -Infinity, Infinity);
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}

// ---------------------------------------------------------------- notation

const FILES = "abcdefgh";
export function squareName(sq) { return FILES[fileOf(sq)] + (rankOf(sq) + 1); }

export function moveName(state, move) {
  const piece = typeOf(state.board[move.from]);
  if (move.castle) { return move.castle === "K" ? "O-O" : "O-O-O"; }
  const letter = { 1: "", 2: "N", 3: "B", 4: "R", 5: "Q", 6: "K" }[piece];
  const takes = state.board[move.to] !== EMPTY || move.enPassant ? "x" : "";
  const from = piece === PAWN && takes ? FILES[fileOf(move.from)] : "";
  const promo = move.promo ? "=" + { 2: "N", 3: "B", 4: "R", 5: "Q" }[move.promo] : "";
  return letter + from + takes + squareName(move.to) + promo;
}

/** Load a position from FEN - used by the perft tests. */
export function fromFEN(fen) {
  const [placement, active, castle, ep] = fen.split(/\s+/);
  const board = new Int8Array(64);
  const letters = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };
  let rank = 7, file = 0;
  for (const ch of placement) {
    if (ch === "/") { rank--; file = 0; continue; }
    if (ch >= "1" && ch <= "8") { file += +ch; continue; }
    const t = letters[ch.toLowerCase()];
    board[rank * 8 + file] = ch === ch.toLowerCase() ? -t : t;
    file++;
  }
  let rights = 0;
  if (castle.includes("K")) { rights |= WK; }
  if (castle.includes("Q")) { rights |= WQ; }
  if (castle.includes("k")) { rights |= BK; }
  if (castle.includes("q")) { rights |= BQ; }
  let epSq = -1;
  if (ep && ep !== "-") { epSq = FILES.indexOf(ep[0]) + (+ep[1] - 1) * 8; }
  return { board, turn: active === "w" ? WHITE : BLACK, castling: rights,
           ep: epSq, halfmove: 0, fullmove: 1 };
}
