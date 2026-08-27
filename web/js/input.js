/*
 * Turns the raw phone sensor stream into the handful of gestures the sports
 * actually care about.
 *
 * The awkward part of using a phone as a Wii remote is that you do not know
 * how the player is holding it. So nothing here depends on a fixed axis:
 *
 *   - swing strength comes from the magnitude of linear acceleration
 *     (gravity subtracted), which is the same whichever way the phone points;
 *   - horizontal sweep is the rotation rate projected onto the *gravity*
 *     vector, i.e. rotation about the real-world vertical axis;
 *   - vertical chop is whatever rotation is left over, perpendicular to that.
 *
 * Aiming does use the phone's own roll axis, but always relative to a
 * reference the player can reset with the "Re-centre aim" button.
 */

const SWING_START = 11.0;   // m/s^2 of linear accel that begins a swing
const SWING_END = 5.0;      // ...and the level it must fall back below
const SWING_MAX = 34.0;     // what counts as a full-power swing
const SWING_TIMEOUT = 420;  // ms, longest a single swing can last
const SWING_COOLDOWN = 220; // ms before another swing may start
const WHEEL_RANGE = 55;     // degrees of phone rotation for full lock

export class Controller {
  constructor(pid) {
    this.pid = pid;
    this.connected = true;
    this.lastPacket = performance.now();

    // raw
    this.ag = [0, 0, 9.81];
    this.rr = [0, 0, 0];
    this.ori = [0, 0, 0];

    // derived
    this.gravity = [0, 0, 9.81];
    this.lin = [0, 0, 0];
    this.speed = 0;        // |linear accel|, m/s^2
    this.energy = 0;       // 0..1, smoothed, nice for meters
    this.yaw = 0;          // deg/s about world vertical (signed)
    this.pitchRate = 0;    // deg/s perpendicular to vertical (unsigned)
    this.aim = 0;          // -1..1, phone roll vs calibration
    this.lean = 0;         // -1..1, phone pitch vs calibration
    this.wheel = 0;        // -1..1, steering-wheel angle (phone held sideways)
    this.wheelAngle = 0;   // the same thing in degrees, uncalibrated

    this.buttons = { a: false, gas: false, brake: false };
    this.button = false;
    this.buttonPressedAt = 0;
    this.buttonReleasedAt = 0;

    this._refRoll = null;
    this._refPitch = null;
    this._refWheel = null;
    this._swinging = false;
    this._swingStart = 0;
    this._lastSwingEnd = -9999;
    this._peak = 0;
    this._peakYaw = 0;
    this._peakPitch = 0;
    this._belowSince = 0;

    this._swingHandlers = [];
    this._buttonHandlers = [];
  }

  onSwing(fn) { this._swingHandlers.push(fn); }
  onButton(fn) { this._buttonHandlers.push(fn); }
  clearHandlers() { this._swingHandlers = []; this._buttonHandlers = []; }

  /** Zero the aim reference to however the phone is currently held. */
  /** Treat however the phone is being held right now as dead centre. */
  calibrate() {
    this._refRoll = this.ori[2];
    this._refPitch = this.ori[1];
    // A phone lying flat gives no usable wheel angle. Keep the previous
    // reference in that case rather than clearing it, or the wheel would
    // silently re-centre later on whatever angle happened to come next.
    const wheel = this._rawWheel();
    if (wheel !== null) { this._refWheel = wheel; }
    this.wheelAngle = 0;
    this.wheel = 0;
    this.aim = 0;
    this.lean = 0;
  }

  /**
   * Steering angle for a phone held sideways like a wheel.
   *
   * Turning a wheel rotates the handset about the axis coming out of its
   * screen, which swings gravity around inside the phone's own X-Y plane. The
   * angle of that projected vector is therefore the wheel angle, and it does
   * not care whether the phone is upright, tilted back, or which way up it was
   * picked up - unlike the deviceorientation roll used for the other sports.
   *
   * Returns null when the phone is lying too flat for the projection to mean
   * anything, so the last good reading can be held instead of jittering.
   */
  _rawWheel() {
    const gx = this.gravity[0], gy = this.gravity[1];
    if (Math.hypot(gx, gy) < 2.5) { return null; }   // screen near horizontal
    return Math.atan2(gx, -gy) * 180 / Math.PI;
  }

  handleMotion(msg) {
    const now = performance.now();
    this.lastPacket = now;
    this.connected = true;

    if (msg.ag) { this.ag = msg.ag; }
    if (msg.rr) { this.rr = msg.rr; }
    if (msg.o) { this.ori = msg.o; }

    // --- separate gravity from real movement -----------------------------
    const k = 0.90;
    for (let i = 0; i < 3; i++) {
      this.gravity[i] = this.gravity[i] * k + this.ag[i] * (1 - k);
      this.lin[i] = this.ag[i] - this.gravity[i];
    }
    this.speed = Math.hypot(this.lin[0], this.lin[1], this.lin[2]);
    this.energy = Math.max(this.energy * 0.88, Math.min(1, this.speed / SWING_MAX));

    // --- split rotation into "about vertical" and "the rest" --------------
    const gl = Math.hypot(this.gravity[0], this.gravity[1], this.gravity[2]) || 1;
    const gx = this.gravity[0] / gl, gy = this.gravity[1] / gl, gz = this.gravity[2] / gl;
    // rotationRate is [alpha(z), beta(x), gamma(y)] in the phone's own frame
    const rx = this.rr[1], ry = this.rr[2], rz = this.rr[0];

    this.yaw = rx * gx + ry * gy + rz * gz;
    const px = rx - this.yaw * gx, py = ry - this.yaw * gy, pz = rz - this.yaw * gz;
    this.pitchRate = Math.hypot(px, py, pz);

    // --- aim from calibrated roll / pitch ---------------------------------
    if (this._refRoll === null) { this.calibrate(); }
    this.aim = clampSigned(shortestAngle(this.ori[2] - this._refRoll) / 38);
    this.lean = clampSigned(shortestAngle(this.ori[1] - this._refPitch) / 38);

    const raw = this._rawWheel();
    if (raw !== null) {
      if (this._refWheel === null) { this._refWheel = raw; }
      this.wheelAngle = shortestAngle(raw - this._refWheel);
      this.wheel = clampSigned(this.wheelAngle / WHEEL_RANGE);
    }

    this._trackSwing(now);
  }

  _trackSwing(now) {
    if (!this._swinging) {
      if (this.speed > SWING_START && now - this._lastSwingEnd > SWING_COOLDOWN) {
        this._swinging = true;
        this._swingStart = now;
        this._peak = this.speed;
        this._peakYaw = this.yaw;
        this._peakPitch = this.pitchRate;
        this._belowSince = 0;
      }
      return;
    }

    if (this.speed > this._peak) {
      this._peak = this.speed;
      this._peakYaw = this.yaw;
      this._peakPitch = this.pitchRate;
    }

    if (this.speed < SWING_END) {
      if (!this._belowSince) { this._belowSince = now; }
    } else {
      this._belowSince = 0;
    }

    const settled = this._belowSince && now - this._belowSince > 55;
    const timedOut = now - this._swingStart > SWING_TIMEOUT;
    if (!settled && !timedOut) { return; }

    this._swinging = false;
    this._lastSwingEnd = now;

    const power = clamp01((this._peak - SWING_START) / (SWING_MAX - SWING_START));
    const swing = {
      pid: this.pid,
      power: power,
      peak: this._peak,
      yaw: this._peakYaw,           // signed: which way the wrist swept
      pitchRate: this._peakPitch,   // unsigned: how much vertical chop
      aim: this.aim,
      lean: this.lean,
      button: this.button,
      at: now,
    };
    for (const fn of this._swingHandlers) { fn(swing); }
  }

  /** Synthesise a swing - used by the keyboard stand-in controller. */
  fireSwing(power, yaw, pitchRate) {
    const swing = {
      pid: this.pid,
      power: power,
      peak: SWING_START + power * (SWING_MAX - SWING_START),
      yaw: yaw || 0,
      pitchRate: pitchRate || 0,
      aim: this.aim,
      lean: this.lean,
      button: this.button,
      at: performance.now(),
    };
    for (const fn of this._swingHandlers) { fn(swing); }
  }

  handleButton(down, key) {
    const now = performance.now();
    const k = key || "a";
    if (down === this.buttons[k]) { return; }
    this.buttons[k] = down;
    if (k === "a") {
      this.button = down;
      if (down) { this.buttonPressedAt = now; } else { this.buttonReleasedAt = now; }
    }
    for (const fn of this._buttonHandlers) { fn(down, k, now); }
  }

  get gas() { return this.buttons.gas; }
  get brake() { return this.buttons.brake; }

  /** Seconds the button has been held, or 0. */
  heldFor() {
    return this.button ? (performance.now() - this.buttonPressedAt) / 1000 : 0;
  }
}


/** Keeps one Controller per connected phone. */
export class Controllers {
  constructor() {
    this.map = new Map();
    this.onJoin = null;
    this.onLeave = null;
  }

  get(pid) {
    let c = this.map.get(pid);
    if (!c) {
      c = new Controller(pid);
      this.map.set(pid, c);
      if (this.onJoin) { this.onJoin(c); }
    }
    return c;
  }

  list() {
    return [...this.map.values()].sort((a, b) => a.pid - b.pid);
  }

  /**
   * The controller the single-player sports listen to.
   *
   * A phone that drops and reconnects (screen lock, WiFi blip, page reload) is
   * given a fresh player slot, and the dead one can linger if its close never
   * arrived. Picking purely by lowest id then hands the game a controller that
   * never sends anything again - the swing meter reads zero and aiming stops
   * responding. So prefer whoever has actually sent data recently.
   */
  first() {
    const all = this.list();
    if (!all.length) { return null; }
    const now = performance.now();
    // a live phone streams at ~60 Hz, so anything quiet for over a second and
    // a half is a dropped session rather than the controller in someone's hand
    const fresh = all.filter(c => now - c.lastPacket < 1500);
    return fresh[0] || all[0];
  }

  /** Forget controllers that have been silent long enough to be gone. */
  prune(maxIdleMs) {
    const now = performance.now();
    const limit = maxIdleMs || 15000;
    for (const c of [...this.map.values()]) {
      if (c.pid !== 99 && now - c.lastPacket > limit) { this.remove(c.pid); }
    }
  }

  count() { return this.map.size; }

  remove(pid) {
    const c = this.map.get(pid);
    if (c) {
      this.map.delete(pid);
      if (this.onLeave) { this.onLeave(c); }
    }
  }

  /** Feed a message straight off the websocket. */
  handle(msg) {
    if (msg.t === "m") {
      this.get(msg.pid).handleMotion(msg);
    } else if (msg.t === "b") {
      this.get(msg.pid).handleButton(!!msg.d, msg.k);
    } else if (msg.t === "cal") {
      this.get(msg.pid).calibrate();
    } else if (msg.t === "leave") {
      this.remove(msg.pid);
    }
  }
}


// ---------------------------------------------------------------- helpers

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clampSigned(v) { return v < -1 ? -1 : v > 1 ? 1 : v; }

function shortestAngle(deg) {
  let d = deg % 360;
  if (d > 180) { d -= 360; }
  if (d < -180) { d += 360; }
  return d;
}
