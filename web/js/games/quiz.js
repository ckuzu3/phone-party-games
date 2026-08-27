/*
 * General knowledge quiz - up to four players.
 *
 * The question and the four answers go on the big screen; each phone shows
 * only A, B, C and D. Everyone answers at once and the quickest correct answer
 * is worth the most, so there is a reason to commit rather than wait and see.
 *
 * The question bank is below. Answers are stored with the correct one first
 * and shuffled when the question is asked, so the right answer is not always
 * in the same place.
 */

import * as THREE from "../../lib/three.module.js";
import { addLights, skyDome, clamp, damp, lerp } from "../arena.js";
import { sfx } from "../audio.js";

const QUESTION_TIME = 18;
const QUESTIONS_PER_GAME = 10;
const BASE_POINTS = 100;
const SPEED_BONUS = 60;

const LETTERS = ["A", "B", "C", "D"];
const PLAYER_COLORS = ["#7fe3ff", "#ffd166", "#a0f0a0", "#ff9ecb"];

// Correct answer first in each list; they get shuffled before being shown.
const BANK = [
  // --- geography ---
  ["What is the capital of Australia?", "Canberra", "Sydney", "Melbourne", "Perth"],
  ["What is the largest country in the world by land area?", "Russia", "Canada", "China", "United States"],
  ["Which is the longest river in South America?", "The Amazon", "The Paraná", "The Orinoco", "The Magdalena"],
  ["Mount Everest sits on the border of Nepal and which country?", "China", "India", "Bhutan", "Pakistan"],
  ["What is the smallest country in the world?", "Vatican City", "Monaco", "San Marino", "Liechtenstein"],
  ["What is the capital of Canada?", "Ottawa", "Toronto", "Vancouver", "Montreal"],
  ["Which mountain range separates Europe from Asia?", "The Urals", "The Alps", "The Caucasus", "The Carpathians"],
  ["On which continent is the Sahara desert?", "Africa", "Asia", "Australia", "South America"],
  ["Which sea lies between Europe and Africa?", "The Mediterranean", "The Baltic", "The Black Sea", "The Caspian"],
  ["What is the capital of Japan?", "Tokyo", "Osaka", "Kyoto", "Nagoya"],

  // --- science ---
  ["What is the chemical symbol for gold?", "Au", "Ag", "Go", "Gd"],
  ["How many bones are there in the adult human body?", "206", "186", "224", "252"],
  ["Which planet is known as the Red Planet?", "Mars", "Venus", "Jupiter", "Mercury"],
  ["Which gas do plants take in from the air?", "Carbon dioxide", "Oxygen", "Nitrogen", "Hydrogen"],
  ["What is the hardest naturally occurring substance?", "Diamond", "Quartz", "Steel", "Granite"],
  ["At what temperature does water boil at sea level?", "100 °C", "90 °C", "120 °C", "80 °C"],
  ["What is the largest organ of the human body?", "The skin", "The liver", "The lungs", "The brain"],
  ["How many chambers does the human heart have?", "Four", "Two", "Three", "Six"],
  ["Which planet is the largest in the solar system?", "Jupiter", "Saturn", "Neptune", "Earth"],
  ["What is the chemical symbol for iron?", "Fe", "Ir", "In", "Fr"],
  ["Roughly how fast does light travel?", "300,000 km per second", "300,000 km per hour", "30,000 km per second", "3 million km per second"],
  ["Which blood cells fight infection?", "White blood cells", "Red blood cells", "Platelets", "Plasma cells"],
  ["What force keeps the planets in orbit around the Sun?", "Gravity", "Magnetism", "Friction", "Inertia"],
  ["What does DNA stand for?", "Deoxyribonucleic acid", "Dinucleic acid", "Diribonucleic acid", "Deoxyribose acid"],

  // --- history ---
  ["In which year did the Second World War end?", "1945", "1944", "1946", "1939"],
  ["Who was the first person to walk on the Moon?", "Neil Armstrong", "Buzz Aldrin", "Yuri Gagarin", "Michael Collins"],
  ["In which year did the Berlin Wall come down?", "1989", "1991", "1987", "1993"],
  ["Which civilisation built the pyramids at Giza?", "The Egyptians", "The Romans", "The Greeks", "The Persians"],
  ["In which year did the Titanic sink?", "1912", "1905", "1918", "1923"],
  ["Who was the first President of the United States?", "George Washington", "Thomas Jefferson", "John Adams", "Benjamin Franklin"],
  ["The French Revolution began in which year?", "1789", "1776", "1804", "1750"],
  ["Julius Caesar ruled which empire?", "The Roman Empire", "The Greek Empire", "The Ottoman Empire", "The Persian Empire"],

  // --- arts and letters ---
  ["Who painted the Mona Lisa?", "Leonardo da Vinci", "Michelangelo", "Raphael", "Donatello"],
  ["Who wrote Romeo and Juliet?", "William Shakespeare", "Charles Dickens", "Geoffrey Chaucer", "Christopher Marlowe"],
  ["Who wrote Pride and Prejudice?", "Jane Austen", "Emily Brontë", "Mary Shelley", "George Eliot"],
  ["Which composer wrote the Ninth Symphony that ends with the Ode to Joy?", "Beethoven", "Mozart", "Bach", "Brahms"],
  ["Which painter famously cut off part of his own ear?", "Vincent van Gogh", "Claude Monet", "Pablo Picasso", "Paul Gauguin"],
  ["Who wrote the novel 1984?", "George Orwell", "Aldous Huxley", "Ray Bradbury", "H. G. Wells"],
  ["In which country did origami originate?", "Japan", "China", "Korea", "Thailand"],

  // --- sport ---
  ["How many players from one team are on the pitch in football?", "Eleven", "Nine", "Ten", "Twelve"],
  ["How often are the Summer Olympic Games held?", "Every four years", "Every two years", "Every three years", "Every five years"],
  ["In which sport would you perform a slam dunk?", "Basketball", "Volleyball", "Handball", "Netball"],
  ["What is the maximum break in snooker?", "147", "155", "180", "120"],
  ["In tennis, what is a score of zero called?", "Love", "Nil", "Duck", "Blank"],
  ["How many points is a touchdown worth in American football?", "Six", "Seven", "Three", "Five"],

  // --- the natural world ---
  ["What is the largest animal on Earth?", "The blue whale", "The African elephant", "The giraffe", "The great white shark"],
  ["How many legs does a spider have?", "Eight", "Six", "Ten", "Twelve"],
  ["What is a group of lions called?", "A pride", "A pack", "A herd", "A troop"],
  ["What is the fastest land animal?", "The cheetah", "The lion", "The pronghorn", "The greyhound"],
  ["Which of these birds cannot fly?", "The penguin", "The swift", "The heron", "The kingfisher"],
  ["What is the tallest species of tree?", "The coast redwood", "The oak", "The Douglas fir", "The eucalyptus"],

  // --- general ---
  ["How many sides does a hexagon have?", "Six", "Five", "Seven", "Eight"],
  ["What is the currency of Japan?", "The yen", "The won", "The yuan", "The rupee"],
  ["How many continents are there?", "Seven", "Five", "Six", "Eight"],
  ["Which language has the most native speakers?", "Mandarin Chinese", "English", "Spanish", "Hindi"],
  ["How many strings does a standard guitar have?", "Six", "Four", "Five", "Seven"],
  ["Mixing blue and yellow paint gives which colour?", "Green", "Purple", "Orange", "Brown"],
  ["How many minutes are there in a full day?", "1440", "1200", "960", "1800"],
  ["What is the freezing point of water in Celsius?", "0 °C", "32 °C", "-10 °C", "10 °C"],
];

export class QuizGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = "Quiz";
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
    this.cameras = [this.camera];
    this.panelEl = null;
    this._build();
  }

  /** A quiet backdrop - the question itself is drawn as HTML over the top. */
  _build() {
    const scene = this.scene;
    scene.add(skyDome(0x141a34, 0x2f3a63));
    addLights(scene, { sky: 0xc8d8ff, ambient: 0.9, sun: 0.7, shadowRange: 8 });

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ color: 0x1a2140, roughness: 0.9 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -3;
    scene.add(floor);

    // slowly drifting shapes, just so the backdrop is not dead still
    this.motes = [];
    for (let i = 0; i < 26; i++) {
      const m = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.3 + Math.random() * 0.5, 0),
        new THREE.MeshStandardMaterial({
          color: [0x7fe3ff, 0xffd166, 0xa0f0a0, 0xff9ecb][i % 4],
          roughness: 0.4, transparent: true, opacity: 0.32,
        })
      );
      m.position.set((Math.random() - 0.5) * 34, (Math.random() - 0.5) * 16 + 2,
        -8 - Math.random() * 22);
      m.userData.spin = (Math.random() - 0.5) * 0.6;
      m.userData.bob = Math.random() * 6.3;
      scene.add(m);
      this.motes.push(m);
    }
    this.camera.position.set(0, 1.5, 12);
    this.camera.lookAt(0, 1.5, 0);
  }

  // ------------------------------------------------------------ lifecycle

  enter() {
    const n = clamp(this.ctx.humanCount(), 1, 4);
    this.players = [];
    for (let i = 0; i < n; i++) {
      this.players.push({ seat: i, score: 0, right: 0, answered: null, answeredAt: 0 });
    }

    // pick this game's questions without repeating any
    const pool = BANK.map((q, i) => i);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    this.queue = pool.slice(0, QUESTIONS_PER_GAME);
    this.qNumber = 0;
    this.over = false;
    this.phase = "intro";
    this.phaseAt = performance.now() + 2200;
    this.current = null;

    this._panel();
    this._brief();
    this._syncHud();
    this.ctx.ui.toast("GENERAL KNOWLEDGE",
      QUESTIONS_PER_GAME + " questions  ·  fastest correct answer scores most", 2200);
  }

  exit() {
    if (this.panelEl && this.panelEl.parentNode) {
      this.panelEl.parentNode.removeChild(this.panelEl);
    }
    this.panelEl = null;
    // put the phones back to a normal controller
    for (let i = 0; i < (this.players || []).length; i++) {
      const c = this.ctx.seat(i);
      if (c) { this.ctx.net.mode(c.pid, "", "", "A", "", "default"); }
    }
  }

  _brief() {
    for (let i = 0; i < this.players.length; i++) {
      const c = this.ctx.seat(i);
      if (!c) { continue; }
      this.ctx.net.mode(c.pid, "Quiz - " + (i + 1),
        "Read the question on the screen, then tap A, B, C or D.",
        "A", "tap your answer", "quiz");
    }
  }

  _panel() {
    const host = document.getElementById("scopes");
    if (!host) { return; }
    if (this.panelEl && this.panelEl.parentNode) {
      this.panelEl.parentNode.removeChild(this.panelEl);
    }
    const el = document.createElement("div");
    el.className = "quizPanel";
    host.appendChild(el);
    this.panelEl = el;
  }

  // ------------------------------------------------------------ questions

  _ask() {
    const raw = BANK[this.queue[this.qNumber]];
    const question = raw[0];
    const answers = raw.slice(1).map((text, i) => ({ text, correct: i === 0 }));
    for (let i = answers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [answers[i], answers[j]] = [answers[j], answers[i]];
    }
    this.current = {
      question, answers,
      correct: answers.findIndex(a => a.correct),
      asked: performance.now(),
    };
    for (const p of this.players) { p.answered = null; p.answeredAt = 0; }
    this.timeLeft = QUESTION_TIME;
    this.phase = "asking";

    for (let i = 0; i < this.players.length; i++) {
      const c = this.ctx.seat(i);
      if (c) { this.ctx.net.send({ t: "hud", pid: c.pid, lock: false, hint: "Tap your answer" }); }
    }
    sfx.tone(660, 0.09, { type: "square", gain: 0.12 });
  }

  onButton(down, pid, key) {
    if (!down || this.phase !== "asking") { return; }
    if (!key || key[0] !== "q") { return; }
    const idx = parseInt(key.slice(1), 10) - 1;
    if (!(idx >= 0 && idx < 4)) { return; }

    const seat = this.ctx.seatOf(pid);
    if (seat < 0 || seat >= this.players.length) { return; }
    const p = this.players[seat];
    if (p.answered !== null) { return; }        // one answer each, no changing it

    p.answered = idx;
    p.answeredAt = performance.now();
    sfx.select();
    this.ctx.net.buzz(pid, 25);
    this.ctx.net.send({ t: "hud", pid: pid, lock: true, hint: "Locked in - " + LETTERS[idx] });

    if (this.players.every(x => x.answered !== null)) {
      this.timeLeft = Math.min(this.timeLeft, 0.6);   // everyone is in, move on
    }
  }

  onSwing() { }

  _reveal() {
    this.phase = "reveal";
    this.phaseAt = performance.now() + 3600;
    const c = this.current;

    for (const p of this.players) {
      if (p.answered === c.correct) {
        const took = (p.answeredAt - c.asked) / 1000;
        const speed = Math.round(SPEED_BONUS * clamp(1 - took / QUESTION_TIME, 0, 1));
        p.score += BASE_POINTS + speed;
        p.right++;
        p.lastGain = BASE_POINTS + speed;
      } else {
        p.lastGain = 0;
      }
    }
    const anyRight = this.players.some(p => p.answered === c.correct);
    if (anyRight) { sfx.point(true); } else { sfx.point(false); }
    this._syncHud();
  }

  _next() {
    this.qNumber++;
    if (this.qNumber >= this.queue.length) {
      this.over = true;
      this.phase = "done";
      const ranked = [...this.players].sort((a, b) => b.score - a.score);
      const top = ranked[0];
      if (this.players.length > 1) {
        this.ctx.ui.toast(
          ranked.length > 1 && ranked[0].score === ranked[1].score ? "IT IS A TIE"
            : "PLAYER " + (top.seat + 1) + " WINS",
          top.score + " points  ·  " + top.right + "/" + QUESTIONS_PER_GAME + " right", 12000);
      } else {
        this.ctx.ui.toast("FINISHED",
          top.right + " out of " + QUESTIONS_PER_GAME + "  ·  " + top.score + " points", 12000);
      }
      sfx.cheer(1);
      this.restartAt = performance.now() + 12000;
      this._syncHud();
      return;
    }
    this._ask();
  }

  // ------------------------------------------------------------ update

  update(dt, time) {
    for (const m of this.motes) {
      m.rotation.x += m.userData.spin * dt;
      m.rotation.y += m.userData.spin * 0.7 * dt;
      m.position.y += Math.sin(time * 0.6 + m.userData.bob) * 0.12 * dt;
    }

    const now = performance.now();
    if (this.phase === "intro" && now > this.phaseAt) { this._ask(); }
    else if (this.phase === "asking") {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) { this._reveal(); }
    } else if (this.phase === "reveal" && now > this.phaseAt) { this._next(); }
    else if (this.phase === "done" && this.restartAt && now > this.restartAt) {
      this.restartAt = 0;
      this.enter();
      return;
    }

    this._draw();
    this.ctx.ui.prompt("");
  }

  _draw() {
    if (!this.panelEl) { return; }
    if (this.phase === "intro") {
      this.panelEl.innerHTML = '<div class="qWait">Get your phones ready…</div>';
      return;
    }
    if (this.phase === "done") {
      const ranked = [...this.players].sort((a, b) => b.score - a.score);
      this.panelEl.innerHTML = '<div class="qFinal"><h2>Final scores</h2>'
        + ranked.map((p, i) =>
          '<div class="qRow" style="--c:' + PLAYER_COLORS[p.seat] + '">'
          + '<span class="pos">' + (i + 1) + '</span>'
          + '<span class="who">Player ' + (p.seat + 1) + '</span>'
          + '<span class="pts">' + p.score + '</span>'
          + '<span class="sub">' + p.right + '/' + QUESTIONS_PER_GAME + '</span></div>').join("")
        + '</div>';
      return;
    }
    if (!this.current) { return; }

    const c = this.current;
    const revealing = this.phase === "reveal";
    const options = c.answers.map((a, i) => {
      let cls = "qOpt";
      if (revealing) { cls += i === c.correct ? " right" : " wrong"; }
      const pick = this.players.filter(p => p.answered === i)
        .map(p => '<i style="--c:' + PLAYER_COLORS[p.seat] + '">P' + (p.seat + 1) + '</i>')
        .join("");
      return '<div class="' + cls + '"><b>' + LETTERS[i] + '</b>'
        + '<span>' + a.text + '</span>'
        + (revealing || pick ? '<em>' + pick + '</em>' : '') + '</div>';
    }).join("");

    const bar = revealing ? ""
      : '<div class="qTimer"><i style="width:'
        + clamp(this.timeLeft / QUESTION_TIME * 100, 0, 100).toFixed(1) + '%"></i></div>';

    this.panelEl.innerHTML =
      '<div class="qCount">Question ' + (this.qNumber + 1) + ' of ' + this.queue.length + '</div>'
      + '<div class="qText">' + c.question + '</div>'
      + bar
      + '<div class="qOpts">' + options + '</div>';
  }

  _syncHud() {
    const cards = (this.players || []).map(p =>
      '<div class="quizScore" style="--c:' + PLAYER_COLORS[p.seat] + '">'
      + '<span class="who">P' + (p.seat + 1) + '</span>'
      + '<span class="pts">' + p.score + '</span></div>').join("");
    this.ctx.ui.hud('<div class="quizHud">' + cards + '</div>');
  }
}
