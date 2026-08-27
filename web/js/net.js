/* Screen-side websocket: receives phone input, sends haptics back. */

export class Net {
  constructor() {
    this.ws = null;
    this.online = false;
    this.players = [];
    this.onMessage = null;   // (msg) => void
    this.onStatus = null;    // (online, players) => void
    this._connect();
    setInterval(() => this.send({ t: "p" }), 4000);
  }

  _connect() {
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    const ws = new WebSocket(proto + location.host + "/ws?role=screen");
    this.ws = ws;

    ws.onopen = () => {
      this.online = true;
      this.send({ t: "hello", name: "screen" });
      this._status();
    };

    ws.onclose = () => {
      this.online = false;
      this.players = [];
      this._status();
      setTimeout(() => this._connect(), 900);
    };

    ws.onerror = () => { try { ws.close(); } catch (e) { /* already gone */ } };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === "roster") {
        this.players = msg.players || [];
        this._status();
        return;
      }
      if (msg.t === "p") { return; }
      if (this.onMessage) { this.onMessage(msg); }
    };
  }

  _status() {
    if (this.onStatus) { this.onStatus(this.online, this.players); }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /** Buzz a phone. pid omitted = everyone. */
  buzz(pid, ms, flash) {
    this.send({ t: "buzz", pid: pid || 0, ms: ms || 30, flash: flash !== false });
  }

  /** Tell the phone what sport it is holding, and what its button does. */
  mode(pid, name, hint, button, buttonHint, layout) {
    this.send({
      t: "mode", pid: pid || 0,
      name: name, hint: hint,
      button: button || "A", buttonHint: buttonHint || "",
      layout: layout || "default",
    });
  }
}
