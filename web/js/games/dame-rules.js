/*
 * Dame (draughts / checkers) - German rules on an 8x8 board.
 *
 *   - twelve men each, on the dark squares
 *   - men step one square diagonally forward
 *   - men capture by jumping, forwards *and* backwards
 *   - capturing is compulsory, but when several captures are available you may
 *     pick any of them; the longest is not forced
 *   - a multi-jump must be played out to the end
 *   - a man finishing on the far row becomes a Dame, which slides and captures
 *     any distance along a diagonal ("flying king")
 *   - jumped pieces are lifted only once the whole move is over, so the same
 *     piece can never be jumped twice in one turn
 *
 * Kept separate from the 3D board so the rules can be tested on their own.
 * Squares are 0..63 with 0 = a1; only squares where (file + rank) is even are
 * playable.
 */

export const EMPTY = 0;
export const MAN = 1, KING = 2;
export const WHITE = 1, BLACK = -1;

export const fileOf = (sq) => sq & 7;
export const rankOf = (sq) => sq >> 3;
const onBoard = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const sqOf = (f, r) => r * 8 + f;
export const isPlayable = (sq) => ((fileOf(sq) + rankOf(sq)) & 1) === 0;

export const colorOf = (p) => (p > 0 ? WHITE : p < 0 ? BLACK : 0);
export const typeOf = (p) => Math.abs(p);

const DIAGONALS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export function initialPosition() {
  const board = new Int8Array(64);
  for (let sq = 0; sq < 64; sq++) {
    if (!isPlayable(sq)) { continue; }
    const r = rankOf(sq);
    if (r <= 2) { board[sq] = MAN; }
    else if (r >= 5) { board[sq] = -MAN; }
  }
  return { board, turn: WHITE, moveCount: 0, sinceProgress: 0 };
}

export function cloneState(s) {
  return {
    board: Int8Array.from(s.board), turn: s.turn,
    moveCount: s.moveCount, sinceProgress: s.sinceProgress,
  };
}

/**
 * Every capture sequence starting from `from`.
 * `gone` holds squares already jumped this turn so nothing is taken twice.
 */
function captureSequences(board, from, piece, gone) {
  const color = colorOf(piece);
  const king = typeOf(piece) === KING;
  const out = [];

  for (const [df, dr] of DIAGONALS) {
    let f = fileOf(from) + df, r = rankOf(from) + dr;

    // a Dame may slide any distance before the piece it jumps
    if (king) {
      while (onBoard(f, r) && board[sqOf(f, r)] === EMPTY) { f += df; r += dr; }
    }
    if (!onBoard(f, r)) { continue; }

    const victimSq = sqOf(f, r);
    const victim = board[victimSq];
    if (victim === EMPTY || colorOf(victim) === color || gone.has(victimSq)) { continue; }

    // landing squares beyond the victim
    let lf = f + df, lr = r + dr;
    while (onBoard(lf, lr) && board[sqOf(lf, lr)] === EMPTY) {
      const landing = sqOf(lf, lr);
      const nextGone = new Set(gone);
      nextGone.add(victimSq);

      // continue jumping from the landing square, if possible
      const onward = captureSequences(board, landing, piece, nextGone);
      if (onward.length) {
        for (const seq of onward) {
          out.push({ path: [landing].concat(seq.path),
                     captures: [victimSq].concat(seq.captures) });
        }
      } else {
        out.push({ path: [landing], captures: [victimSq] });
      }

      if (!king) { break; }          // a man lands immediately behind the victim
      lf += df; lr += dr;
    }
  }
  return out;
}

export function legalMoves(state) {
  const { board, turn } = state;
  const captures = [];
  const quiet = [];

  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (piece === EMPTY || colorOf(piece) !== turn) { continue; }
    const king = typeOf(piece) === KING;

    for (const seq of captureSequences(board, from, piece, new Set())) {
      captures.push({ from, path: seq.path, captures: seq.captures,
                      to: seq.path[seq.path.length - 1] });
    }

    if (king) {
      for (const [df, dr] of DIAGONALS) {
        let f = fileOf(from) + df, r = rankOf(from) + dr;
        while (onBoard(f, r) && board[sqOf(f, r)] === EMPTY) {
          quiet.push({ from, path: [sqOf(f, r)], captures: [], to: sqOf(f, r) });
          f += df; r += dr;
        }
      }
    } else {
      for (const df of [-1, 1]) {
        const f = fileOf(from) + df, r = rankOf(from) + turn;
        if (!onBoard(f, r)) { continue; }
        const to = sqOf(f, r);
        if (board[to] === EMPTY) { quiet.push({ from, path: [to], captures: [], to }); }
      }
    }
  }

  // Schlagzwang: if anything can be captured, only captures may be played
  return captures.length ? captures : quiet;
}

export function makeMove(state, move) {
  const s = cloneState(state);
  const b = s.board;
  const piece = b[move.from];
  const to = move.to;

  b[move.from] = EMPTY;
  for (const sq of move.captures) { b[sq] = EMPTY; }

  // promotion happens only if the move *ends* on the far row
  const lastRank = s.turn === WHITE ? 7 : 0;
  const becomesKing = typeOf(piece) === MAN && rankOf(to) === lastRank;
  b[to] = becomesKing ? KING * s.turn : piece;

  s.sinceProgress = (move.captures.length || typeOf(piece) === MAN)
    ? 0 : s.sinceProgress + 1;
  s.moveCount++;
  s.turn = -s.turn;
  s.promoted = becomesKing;
  return s;
}

export function gameResult(state) {
  const moves = legalMoves(state);
  if (moves.length === 0) {
    // no move at all - whether blocked or wiped out, the mover loses
    return { over: true, kind: "win", winner: -state.turn };
  }
  if (state.sinceProgress >= 50) {
    return { over: true, kind: "draw", reason: "no progress in 25 moves" };
  }
  return { over: false };
}

export function countPieces(board, color) {
  let men = 0, kings = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = board[sq];
    if (p === EMPTY || colorOf(p) !== color) { continue; }
    if (typeOf(p) === KING) { kings++; } else { men++; }
  }
  return { men, kings, total: men + kings };
}

// ---------------------------------------------------------------- the engine

const MAN_VALUE = 100;
const KING_VALUE = 260;

function evaluate(state) {
  let score = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = state.board[sq];
    if (p === EMPTY) { continue; }
    const c = colorOf(p);
    if (typeOf(p) === KING) {
      score += c * KING_VALUE;
    } else {
      // men are worth more the closer they are to promoting
      const advance = c === WHITE ? rankOf(sq) : 7 - rankOf(sq);
      score += c * (MAN_VALUE + advance * 8);
      // and a little safer hugging the edge
      const f = fileOf(sq);
      if (f === 0 || f === 7) { score += c * 4; }
    }
  }
  return score * state.turn;
}

function search(state, depth, alpha, beta) {
  const moves = legalMoves(state);
  if (moves.length === 0) { return -100000 + (10 - depth); }
  if (state.sinceProgress >= 50) { return 0; }
  if (depth === 0) { return evaluate(state); }

  // a forced single reply is cheap to look at, so do not spend depth on it
  const ordered = moves.slice().sort((a, b) => b.captures.length - a.captures.length);
  let best = -Infinity;
  for (const m of ordered) {
    const score = -search(makeMove(state, m), depth - 1, -beta, -alpha);
    if (score > best) { best = score; }
    if (best > alpha) { alpha = best; }
    if (alpha >= beta) { break; }
  }
  return best;
}

export function bestMove(state, depth) {
  const moves = legalMoves(state);
  if (moves.length === 0) { return null; }
  if (moves.length === 1) { return moves[0]; }
  const ordered = moves.slice().sort((a, b) => b.captures.length - a.captures.length);
  let best = null, bestScore = -Infinity;
  for (const m of ordered) {
    const score = -search(makeMove(state, m), (depth || 5) - 1, -Infinity, Infinity);
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}

// ---------------------------------------------------------------- notation

const FILES = "abcdefgh";
export function squareName(sq) { return FILES[fileOf(sq)] + (rankOf(sq) + 1); }

export function moveName(move) {
  const sep = move.captures.length ? "x" : "-";
  return [move.from].concat(move.path).map(squareName).join(sep);
}

/** Count the leaves of the move tree - the same self-check used for chess. */
export function perft(state, depth) {
  if (depth === 0) { return 1; }
  const moves = legalMoves(state);
  if (depth === 1) { return moves.length; }
  let total = 0;
  for (const m of moves) { total += perft(makeMove(state, m), depth - 1); }
  return total;
}
