/* Game screen: menu, the render loop, and routing phone input into whichever sport is running. */

import { makeRenderer, fitCamera } from "./arena.js";
import { drawQR } from "./qr.js";
import { Net } from "./net.js";
import { Controllers, Controller } from "./input.js";
import { sfx } from "./audio.js";
import { TennisGame } from "./games/tennis.js";
import { BowlingGame } from "./games/bowling.js";
import { BoxingGame } from "./games/boxing.js";
import { RacingGame } from "./games/racing.js";
import { DuckGame } from "./games/ducks.js";
import { ConnectFourGame } from "./games/connect4.js";
import { BattleshipsGame } from "./games/battleships.js";
import { ChessGame } from "./games/chess.js";
import { DameGame } from "./games/dame.js";
import { BasketballGame } from "./games/basketball.js";
import { DartsGame } from "./games/darts.js";
import { CupPongGame } from "./games/cuppong.js";
import { GolfGame } from "./games/golf.js";
import { BilliardsGame } from "./games/billiards.js";
import { TanksGame } from "./games/tanks.js";
import { AirHockeyGame } from "./games/airhockey.js";
import { BaseballGame } from "./games/baseball.js";
import { LightCyclesGame } from "./games/lightcycles.js";
import { QuizGame } from "./games/quiz.js";

const $ = (id) => document.getElementById(id);

const GAMES = {
  tennis: TennisGame,
  bowling: BowlingGame,
  boxing: BoxingGame,
  racing: RacingGame,
  ducks: DuckGame,
  connect4: ConnectFourGame,
  battleships: BattleshipsGame,
  chess: ChessGame,
  dame: DameGame,
  basketball: BasketballGame,
  darts: DartsGame,
  cuppong: CupPongGame,
  golf: GolfGame,
  billiards: BilliardsGame,
  tanks: TanksGame,
  airhockey: AirHockeyGame,
  baseball: BaseballGame,
  lightcycles: LightCyclesGame,
  quiz: QuizGame,
};
/*
 * The running order is read off the menu markup at start-up rather than kept
 * as a second list here. Holding it in both places meant that inserting a new
 * card anywhere but the end silently shifted every card after it onto the
 * wrong game - clicking Battleships started Racing.
 */

class App {
  constructor() {
    this.renderer = makeRenderer($("gl"));
    this.game = null;
    this.menuIndex = 0;
    this.inMenu = true;
    this.gameStartedAt = 0;
    this.swallowRelease = false;
    this.lastTiltStep = 0;
    this.cache = {};

    this.order = [...document.querySelectorAll(".card")].map(c => c.dataset.game)
      .filter(name => GAMES[name]);

    this.ui = this._makeUi();
    this.net = new Net();
    this.controllers = new Controllers();

    // Stable player slots. Phones are seated in the order they connect, so
    // "player 2" keeps meaning the same handset even if ids change underneath.
    this.seats = [];
    this.keyboardSeat = false;

    this.ctx = {
      renderer: this.renderer,
      net: this.net,
      controllers: this.controllers,
      ui: this.ui,
      sfx: sfx,
      seatOf: (pid) => this.seatOf(pid),
      seat: (i) => this.seatController(i),
      humanCount: () => this.humanCount(),
    };

    this._wireNet();
    this._wireControllers();
    this._wireKeyboard();
    this._wireMenu();
    this._wireResize();

    this._showJoinUrl();
    this._selectCard(0);
    this._loop = this._loop.bind(this);
    this.last = performance.now() / 1000;
    this.lastPrune = this.last;
    requestAnimationFrame(this._loop);
  }

  // -------------------------------------------------------------- ui

  _makeUi() {
    let toastTimer = 0;
    return {
      hud(html) { $("hud").innerHTML = html; },
      toast(big, small, ms) {
        $("toastBig").textContent = big || "";
        $("toastSmall").textContent = small || "";
        $("toast").classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => $("toast").classList.remove("show"), ms || 1500);
      },
      prompt(text) {
        const el = $("prompt");
        if (text) {
          el.textContent = text;
          el.classList.add("show");
        } else {
          el.classList.remove("show");
        }
      },
    };
  }

  /**
   * The phone always needs the https address, which is a different port from
   * the one this page is usually served on - so ask the server for it rather
   * than guessing from location.
   */
  async _showJoinUrl() {
    const el = $("joinUrl");
    try {
      const res = await fetch("/info", { cache: "no-store" });
      const info = await res.json();
      el.textContent = info.phoneUrl;
      if (info.ips && info.ips.length > 1) {
        el.title = "Other addresses for this PC: " + info.ips.join(", ");
      }
      // a scannable version of the same address, so nobody has to type an IP
      try {
        const box = $("qrBox");
        if (drawQR($("qr"), info.phoneUrl, { pixels: 300, quiet: 4 })) {
          box.classList.add("on");
        }
      } catch (e) {
        /* the address still shows as text, which is enough to get going */
      }
    } catch (e) {
      el.textContent = "see the server window for the address";
      el.style.fontSize = "18px";
    }
  }

  // -------------------------------------------------------------- net

  _wireNet() {
    this.net.onStatus = (online, players) => {
      this.online = online;
      this.roster = players;
      this._refreshRoster();
    };

    this.net.onMessage = (msg) => {
      if (msg.t === "menu") { this._toMenu(); return; }
      this.controllers.handle(msg);
      // some games carry their own aim state on top of the controller's
      // reference angles, and that has to be zeroed too
      if (msg.t === "cal" && !this.inMenu && this.game && this.game.onCalibrate) {
        this.game.onCalibrate(msg.pid);
      }
    };
  }

  _wireControllers() {
    const attach = (c) => {
      c.onSwing((swing) => {
        if (this.inMenu) { return; }
        if (this.game && this.game.onSwing) { this.game.onSwing(swing); }
      });
      c.onButton((down, key) => {
        if (key && key !== "a") {
          // pedals only ever mean something to the game that asked for them
          if (!this.inMenu && this.game && this.game.onButton) {
            this.game.onButton(down, c.pid, key);
          }
          return;
        }
        if (this.inMenu) {
          if (down) {
            // the matching release belongs to the menu, not to the game
            this.swallowRelease = true;
            this._startSelected();
          }
          return;
        }
        if (!down && this.swallowRelease) { this.swallowRelease = false; return; }
        if (down) { this.swallowRelease = false; }
        if (this.game && this.game.onButton) { this.game.onButton(down, c.pid, "a"); }
      });
    };

    this.controllers.onJoin = (c) => {
      attach(c);
      this._seat(c);
      sfx.select();
      this._refreshRoster();
      if (this.inMenu) { this._pushMenuMode(); }
    };
    this.controllers.onLeave = (c) => {
      this._unseat(c);
      this._refreshRoster();
    };

    // keyboard stand-in so the game is playable without a phone
    this.kb = new Controller(99);
    this.controllers.map.set(99, this.kb);
    attach(this.kb);
  }

  /** Connection strip plus the menu's "who is playing" line. */
  _refreshRoster() {
    const players = this.roster || [];
    const online = this.online;
    const seated = this.seats.length + (this.keyboardSeat ? 0 : 0);

    $("connDot").classList.toggle("on", online && players.length > 0);
    $("connText").textContent = !online
      ? "server offline"
      : players.length === 0
        ? "waiting for a phone"
        : players.length + " controller" + (players.length === 1 ? "" : "s") + " connected";

    const pills = this.seats.map((pid, i) =>
      '<span class="pill">P' + (i + 1) + (pid === 99 ? " keyboard" : "") + "</span>");
    $("joinList").innerHTML = pills.length ? pills.join(" ")
      : '<span class="pill off">none yet</span>';

    const el = $("modeLine");
    if (el) {
      el.textContent = seated >= 2
        ? "2 players — P2 controls the opponent in Tennis and Boxing"
        : "1 player — connect a second phone to play against a friend"
          + " (or press K to add the PC keyboard as player 2)";
      el.classList.toggle("ready", seated >= 2);
    }
  }

  // ------------------------------------------------------------ seats

  /** Which player slot a controller drives, or -1 if it has none. */
  seatOf(pid) {
    const i = this.seats.indexOf(pid);
    if (i >= 0) { return i; }
    // with no phone seated at all, whatever is driving counts as player one
    if (this.seats.length === 0) {
      const f = this.controllers.first();
      if (f && f.pid === pid) { return 0; }
    }
    return -1;
  }

  seatController(i) {
    const pid = this.seats[i];
    if (pid !== undefined) { return this.controllers.map.get(pid) || null; }
    if (i === 0 && this.seats.length === 0) { return this.controllers.first(); }
    return null;
  }

  humanCount() {
    return Math.max(1, this.seats.length);
  }

  _seat(c) {
    if (c.pid === 99 && !this.keyboardSeat) { return; }
    if (!this.seats.includes(c.pid)) { this.seats.push(c.pid); }
  }

  _unseat(c) {
    const i = this.seats.indexOf(c.pid);
    if (i >= 0) { this.seats.splice(i, 1); }
  }

  /** Lets a second player use the PC keyboard when only one phone is around. */
  _toggleKeyboardSeat() {
    this.keyboardSeat = !this.keyboardSeat;
    if (this.keyboardSeat) { this._seat(this.kb); } else { this._unseat(this.kb); }
    this.net.mode(0, "", "", "", "");
    this._refreshRoster();
    this.ui.toast(this.keyboardSeat ? "KEYBOARD JOINED" : "KEYBOARD LEFT",
      this.keyboardSeat ? "the PC keyboard is now a player" : "", 1600);
  }

  _pushMenuMode() {
    this.net.mode(0, "Choose a sport",
      "Tilt left and right to move, press the button to start.",
      "START", "Press to start the highlighted sport");
  }

  // -------------------------------------------------------------- input

  _wireKeyboard() {
    const kb = this.kb;
    this.keysHeld = new Set();
    let aim = 0, lean = 0;

    const push = () => {
      // feed the virtual controller a believable "at rest" motion packet
      kb.handleMotion({ ag: [0, 0, 9.81], rr: [0, 0, 0], o: [0, lean * 38, aim * 38] });
    };

    window.addEventListener("keydown", (e) => {
      this.keysHeld.add(e.code);
      if (e.repeat) { return; }
      switch (e.code) {
        case "Escape":
          this._toMenu();
          break;
        case "ArrowLeft":
          if (this.inMenu) { this._selectCard(this.menuIndex - 1); }
          else { aim = Math.max(-1, aim - 0.34); push(); }
          break;
        case "ArrowRight":
          if (this.inMenu) { this._selectCard(this.menuIndex + 1); }
          else { aim = Math.min(1, aim + 0.34); push(); }
          break;
        case "ArrowUp": lean = Math.max(-1, lean - 0.34); push(); break;
        case "ArrowDown": lean = Math.min(1, lean + 0.34); push(); break;
        case "Enter":
          if (this.inMenu) { this._startSelected(); }
          break;
        case "Space":
          e.preventDefault();
          if (this.inMenu) { this._startSelected(); }
          else { kb.fireSwing(0.78, aim * 240, 190); }
          break;
        case "ShiftLeft":
        case "KeyB":
          kb.handleButton(true);
          break;
        case "KeyC":
          aim = 0; lean = 0; push();
          break;
        case "KeyK":
          this._toggleKeyboardSeat();
          break;
        case "KeyW":
          kb.handleButton(true, "gas");
          break;
        case "KeyS":
          kb.handleButton(true, "brake");
          break;
        default:
          break;
      }
    });

    window.addEventListener("keyup", (e) => {
      if (e.code === "ShiftLeft" || e.code === "KeyB") { kb.handleButton(false); }
      if (e.code === "KeyW") { kb.handleButton(false, "gas"); }
      if (e.code === "KeyS") { kb.handleButton(false, "brake"); }
      this.keysHeld.delete(e.code);
    });

    push();
  }

  _wireMenu() {
    document.querySelectorAll(".card").forEach((card, i) => {
      card.addEventListener("mouseenter", () => this._selectCard(i));
      card.addEventListener("click", () => { this._selectCard(i); this._startSelected(); });
    });
  }

  _wireResize() {
    const resize = () => {
      const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
      this.renderer.setSize(w, h, false);
      if (this.game) { this._fitCameras(this.game, w, h); }
    };
    window.addEventListener("resize", resize);
    resize();
  }

  // -------------------------------------------------------------- menu

  _selectCard(i) {
    const n = this.order.length;
    this.menuIndex = ((i % n) + n) % n;
    document.querySelectorAll(".card").forEach((card, k) => {
      const on = k === this.menuIndex;
      card.classList.toggle("sel", on);
      // with this many games the grid can run past the bottom of the window,
      // so the highlighted one has to be brought into view
      if (on && card.scrollIntoView) {
        card.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    });
    sfx.move();
  }

  /** Tilting the phone scrolls the menu, with a dead zone so it does not race. */
  _menuTilt() {
    const c = this.controllers.list().find(x => x.pid !== 99) || this.kb;
    if (!c) { return; }
    const now = performance.now();
    if (now - this.lastTiltStep < 330) { return; }
    if (c.aim > 0.45) { this._selectCard(this.menuIndex + 1); this.lastTiltStep = now; }
    else if (c.aim < -0.45) { this._selectCard(this.menuIndex - 1); this.lastTiltStep = now; }
  }

  _startSelected() {
    sfx.resume();
    sfx.select();
    this._start(this.order[this.menuIndex]);
  }

  _start(key) {
    const Klass = GAMES[key];
    if (!Klass) { return; }

    if (this.game && this.game.exit) { this.game.exit(); }

    // scenes are expensive to build, so keep them around between rounds
    let game = this.cache[key];
    if (!game) {
      game = new Klass(this.ctx);
      this.cache[key] = game;
    }
    this.game = game;

    this.inMenu = false;
    this.gameStartedAt = performance.now();
    $("menu").style.display = "none";
    this.ui.prompt("");
    game.enter();

    // enter() decides how many cameras the sport wants, so size them after it
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    this._fitCameras(game, w, h);
  }

  /** A game may expose several cameras when it is running split-screen. */
  _fitCameras(game, w, h) {
    const cams = game.cameras && game.cameras.length ? game.cameras : [game.camera];
    const each = w / cams.length;
    for (const cam of cams) {
      fitCamera(cam, each / h);
    }
    const divider = document.getElementById("divider");
    if (divider) { divider.style.display = cams.length > 1 ? "block" : "none"; }
  }

  _toMenu() {
    if (this.inMenu) { return; }
    if (this.game && this.game.exit) { this.game.exit(); }
    this.game = null;
    this.inMenu = true;
    $("menu").style.display = "flex";
    $("hud").innerHTML = "";
    const divider = document.getElementById("divider");
    if (divider) { divider.style.display = "none"; }
    this.ui.prompt("");
    $("toast").classList.remove("show");
    this._pushMenuMode();
    sfx.select();
  }

  // -------------------------------------------------------------- loop

  _loop() {
    requestAnimationFrame(this._loop);
    const now = performance.now() / 1000;
    let dt = now - this.last;
    this.last = now;
    if (dt > 0.05) { dt = 0.05; }        // never let a stall throw the physics

    if (now - this.lastPrune > 2) {
      this.lastPrune = now;
      this.controllers.prune();
    }

    // the keyboard stand-in steers with held arrow keys
    if (this.keysHeld) {
      this.kb.wheel = (this.keysHeld.has("ArrowRight") ? 1 : 0)
        - (this.keysHeld.has("ArrowLeft") ? 1 : 0);
    }

    if (this.inMenu) {
      this._menuTilt();
      return;
    }
    if (!this.game) { return; }

    this.game.update(dt, now);
    if (this.game.render) {
      this.game.render(this.renderer);
    } else {
      this.renderer.render(this.game.scene, this.game.camera);
    }
  }
}

window.addEventListener("error", (e) => {
  const el = document.getElementById("connText");
  if (el) { el.textContent = "error: " + e.message; }
});

// exposed so the browser console can poke at a running match while debugging
window.sports = new App();
