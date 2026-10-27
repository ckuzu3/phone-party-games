# Phone Party Games — your phone is the controller

Nineteen games that run in a browser on your PC, with your phone acting as the
controller over your home WiFi: tennis, bowling, boxing, racing, basketball,
baseball, golf, darts, cup pong, billiards, air hockey, duck shooting, tank
duel, light cycles, four in a row, battleships, chess, Dame and a general
knowledge quiz.

No installation, no accounts, nothing leaves your network. The server is a
single Python file using only the standard library, and the game is plain
JavaScript with a copy of three.js included.

## Running it

1. Double-click **`START-GAME.bat`**.
   (Or from a terminal in this folder: `python server.py`)

2. The game screen opens on your PC at **http://localhost:8080/**

3. The server window prints the address for your phone — something like:

   ```
   https://192.168.1.120:8443/phone
   ```

   Type that into your phone's browser. **Your phone must be on the same
   WiFi as the PC.**

4. Your phone will warn that the connection is not private. **This is
   expected — tap "Advanced", then "Proceed" / "Visit this website".**
   See the note below for why.

5. Tap **TAP TO CONNECT** and allow motion access. Your phone becomes a
   controller: hold it like a TV remote and swing.

Press `Ctrl+C` in the server window to stop.

## Why the certificate warning?

Phone browsers refuse to hand out accelerometer and gyroscope data over a
plain `http://` connection — motion sensors require a secure origin. So the
controller page has to be served over `https://`.

A certificate can only be vouched for by a public authority if it belongs to a
public domain name. This server runs on your own machine on a private address,
so it signs its own certificate, and your phone quite correctly points out that
it has never heard of it. The traffic is still encrypted; it just is not
endorsed by anyone.

The PC game screen has no such requirement, so it is served over plain HTTP
with no warning at all.

The certificate is generated on first run into `certs/` and is rebuilt
automatically if your PC's IP address changes. That folder holds a private key,
so it is not in version control; delete it any time and the server makes a new
one.

## The controls

Hold the phone like a Wii remote. Nothing depends on exactly how you grip it —
swing strength comes from raw acceleration, and turns are measured against
gravity, so it works whichever way the phone is pointing. If aiming ever feels
off-centre, tap **Re-centre** on the phone.

### Tennis
Your player runs to the ball on their own; you only supply the swing.

| Action | How |
| --- | --- |
| Serve | Swing once to toss, swing again to hit |
| Return | Swing as the ball arrives — timing decides how clean the contact is |
| Aim | Tilt left or right as you swing |
| Power | Swing harder for a deeper ball |

Scoring is real tennis: 15/30/40, deuce and advantage. First to four games
wins the match.

### Bowling
| Action | How |
| --- | --- |
| Move across the approach | Tilt the phone left/right |
| Angle your run-up | Tilt forwards/backwards |
| Bowl | Just swing your arm down and forward — the ball leaves your hand at the bottom of the arc |
| Bowl (precise) | Or **hold** the button, swing, and **release** exactly when you want to let go |
| Hook | Turn your wrist as you swing |

Both release styles work. Use whichever feels natural — you do not need to
touch the button at all if you would rather just swing.

Power comes from swing speed. The hook only bites in the back half of the lane,
so the classic line — start wide, curve into the pocket — is the one that
strikes. Ten frames, proper strike and spare bonuses.

### Boxing
| Action | How |
| --- | --- |
| Punch | Throw the phone forward |
| Left / right hand | Tilt that way as you punch |
| Hook | Turn your wrist hard as you punch |
| Uppercut | Sharp upward chop |
| Guard | Hold the button |
| Dodge | Tilt hard left or right without punching |

The opponent telegraphs most punches — hit them mid-wind-up for a counter that
interrupts the shot. About a third of their punches are fast jabs that you can
only block or slip. You cannot guard in the middle of your own punch, so
swinging wildly gets you hit. Three rounds, or a knockout.

### Racing
**Hold the phone sideways, like a steering wheel**, and turn it to steer. The
right half of the touchscreen is the **gas**, the left half the **brake**.

| Action | How |
| --- | --- |
| Steer | Rotate the phone like a wheel |
| Accelerate | Hold the right pedal |
| Brake / reverse | Hold the left pedal |
| Centre the wheel | "Centre the wheel" on the phone |

Three laps of a closed circuit against five computer drivers. Off the tarmac
you lose grip and speed, and the barriers cost you a lot of momentum. Lap and
best-lap times are shown as you go.

The controller switches to the pedal layout by itself when you pick Racing,
and back again when you leave.

### Duck Shooting
Point the phone like a gun; your scope shows on screen. Press to fire.

| Action | How |
| --- | --- |
| Aim across | Turn the phone left and right |
| Aim up and down | Tilt the phone up and down |
| Fire | Press the button |
| Fix drifting aim | "Re-centre" on the phone |

Three shells per wave, ten waves. Up and down is measured against gravity so it
never drifts; left and right is measured from how fast you turn, which can
creep over a long session — that is what the re-centre button is for.

### Four in a Row
Tilt to slide your disc across the top, press to drop it. First to line up four
in any direction wins. With one phone you play red against the computer, which
searches six moves ahead.

### Battleships
Tilt to move the crosshair over the enemy grid, press to fire. **A hit earns
another shot**, a miss passes the turn. Five ships each, placed at random. Sink
the enemy fleet to win.

Your own fleet is shown in full on the left so you can watch the damage come
in. With two players on one screen that means your opponent can see your
layout too.

### Chess
Tilt to slide the cursor around the board, press to pick a piece up, press
again on a highlighted square to move it. Legal moves are marked as you go —
green for a quiet move, a red ring for a capture.

Full rules: castling, en passant, promotion (always to a queen), check,
checkmate and stalemate. With one phone you play white against a search three
moves deep; with two, the board turns to face whoever is to move.

### Dame (draughts)
German rules on an 8x8 board, twelve pieces each. Same controls as chess: tilt
to the piece, press to pick it up, press again to move.

| Rule | |
| --- | --- |
| Men | Step one square diagonally forward |
| Capturing | Compulsory — if a jump exists, quiet moves are not offered |
| Men capture | Forwards **and** backwards |
| Choice | Any available capture will do; the longest is not forced |
| Dame (king) | A man reaching the far row is crowned, and then slides and captures any distance along a diagonal |

A multi-jump is played one hop at a time: after each landing the next options
are shown, and the pieces you are taking fade out as you go. The move is only
committed once the chain has nowhere left to go, so nothing is final until the
sequence ends.

### Basketball
Tilt to aim, then swing the phone up and forward to shoot. A **middling swing
is the money shot** — too soft falls short, too hard clangs off the back of the
rim. Lean as you swing to flatten or steepen the arc. Seventy-five seconds,
shooting from six spots in turn; threes, swishes and streaks all pay extra.

### Mini Golf
Nine holes. Tilt to swing the aim line around, then swing to putt — gently for
a short roll. The ball bounces off the rails, so bank shots work. Par is shown
for each hole and the lowest total wins.

### Darts
501 down to exactly zero, three darts a turn. Tilt to move the sight, then
throw the phone forward. A smooth, medium throw is the accurate one; rushing it
scatters the dart. Going below zero, or to exactly one, is a bust and the turn
scores nothing.

### Cup Pong
Ten cups in a triangle. Tilt to aim, swing to throw — bounce shots off the
table count. Sink one and you throw again. Clear the rack to win.

### Billiards
Tilt to swing the cue around the white, then swing the phone to strike. Pot a
ball and you shoot again; miss, or pot the cue ball, and the turn passes.

### Tank Duel
Turn-based artillery. Tilt to set the barrel angle, **hold the button to build
power and let go to fire**. Wind changes every turn and is shown in the middle
of the health bars. Shells dig craters, so the ground you are standing on will
not stay where it was.

### Air Hockey
Tilt to slide your mallet around your own half — forwards and back as well as
side to side. There is no button: pace comes from how fast the mallet is
actually moving when it meets the puck, so wind up rather than poke at it.
First to seven.

### Baseball
A pitch comes in; swing as it reaches the plate. Timing decides everything —
swing early to pull it, late to push it the other way, and lean as you swing to
set the launch angle. Three outs an innings, three innings each. There are
fielders standing where you would expect them, so placing the ball in a gap
matters as much as hitting it hard.

### Light Cycles
**Up to four players.** Everyone rides forward all the time leaving a solid
wall behind them. Tilt left or right to turn a quarter turn — let the phone
come back to centre before turning again. Last one riding wins. With fewer than
four phones the computer fills the empty seats.

### Quiz
**Up to four players.** General knowledge, ten questions a game. The question
and the four answers appear on the big screen; your phone shows just A, B, C
and D. Everyone answers at once and the quickest correct answer scores most, so
there is a reason to commit rather than wait and see.

## No phone? Keyboard controls

The game screen is fully playable without a phone, which is handy for testing:

| Key | Does |
| --- | --- |
| `Space` | Swing / punch / bowl / fire |
| `W` / `S` | Gas / brake (Racing) |
| `←` `→` held | Steer (Racing) |
| `Shift` or `B` | Hold the button (guard, bowling wind-up) |
| Arrow keys | Aim and lean |
| `C` | Re-centre aim |
| `Enter` | Choose a sport |
| `Esc` | Back to the menu |
| `K` | Seat the keyboard as player 2 (or unseat it) |

## Troubleshooting

**The phone cannot reach the address at all.**
Windows Firewall is the usual cause — the first time Python opens a port,
Windows asks whether to allow it, and it is easy to dismiss. To add the rule
manually, open PowerShell **as Administrator** and run:

```powershell
New-NetFirewallRule -DisplayName "Phone Party Games" -Direction Inbound -Protocol TCP -LocalPort 8080,8443 -Action Allow -Profile Private
```

Also check that both devices really are on the same network — phones sometimes
sit on a "guest" WiFi that is isolated from everything else, and mobile data
can take over if the WiFi signal is weak.

**Connected, but swinging does nothing.**
The controller page shows a live energy bar that fills as you move. If it never
moves, the browser is not giving out motion data:

- Make sure the address really is `https://`, not `http://`.
- On iPhone, motion access is only offered on a tap, and only once per page
  load — reload the page and tap **TAP TO CONNECT** again, then **Allow**.
- On iPhone, check Settings → Safari → Motion & Orientation Access is on.
- Some third-party browsers block sensors entirely. Safari and Chrome work.

**"Waiting for a phone" never changes.**
The phone reached the page but the WebSocket did not connect. This is almost
always the certificate — if you only dismissed the warning rather than
proceeding through it, the page loads from cache but the socket is refused.
Reload and take the "Proceed anyway" option.

**The bowling ball will not leave my hand.**
Swing harder — the throw needs a genuine arm-swing, not a wrist flick. You can
also hold the button down, swing, and let go, which releases the ball the
moment your thumb lifts regardless of how gentle the swing was. If the swing
meter on the phone barely moves when you swing, the sensors are the problem,
not the throw — see the previous item.

**The IP address changed.**
Just restart the server. It detects the new address and reissues the
certificate automatically. Your phone will show the warning once more.

## Two players

Connect a second phone to the same address and it takes over the opponent.
Nothing to configure — the menu shows **2 players** once the second controller
is in, and Tennis and Boxing switch out of computer control automatically.
Whoever connects first is player 1.

The screen splits down the middle: **player 1 on the left, player 2 on the
right**, each looking out from behind their own athlete. So both halves show
"your" side of the court or ring, and tilting right always steers right from
the point of view of whoever is holding that phone.

| Game | With two players |
| --- | --- |
| Tennis | Player 2 plays the far end. Split screen. |
| Boxing | Player 2 takes the red corner. Split screen, fully symmetric. |
| Racing | Player 2 gets their own car and half the screen. |
| Duck Shooting | Everyone shoots the same flock on one shared screen, each with their own coloured scope, shells and score. Up to four players. |
| Four in a Row | Player 2 plays yellow instead of the computer. |
| Battleships | Player 2 commands the second fleet. |
| Chess | Player 2 plays black instead of the computer. The board rotates to face whoever is to move. |
| Dame | Player 2 plays the dark pieces. The board rotates the same way. |
| Basketball, Golf, Darts, Cup Pong, Billiards | Players alternate on one shared screen, each with their own score. |
| Tank Duel | Player 2 takes the second tank instead of the computer. |
| Air Hockey, Baseball | Player 2 takes the other end. |
| Light Cycles, Quiz | Up to **four** players at once, each on their own phone. |
| Bowling | Still one bowler. A second phone is ignored so it cannot throw your ball. |

Duck Shooting, Four in a Row and Battleships share one screen rather than
splitting it. In Battleships the un-hit parts of your own fleet stay hidden
while two people are playing, so your opponent cannot simply read your ship
positions off the screen.

If a phone drops out mid-session the game falls back to one player, and the
computer opponent takes over again the next time you start a match.

**No second phone?** Press `K` on the PC to seat the keyboard as player 2 —
useful for trying the split-screen out on your own. Press `K` again to remove
it.

Extra phones beyond the second connect fine and are listed, but the sports here
are one-against-one, so they do not control anything.

## How it is put together

```
server.py            HTTPS + HTTP server, and a WebSocket relay, stdlib only
web/index.html       the game screen (PC)
web/phone.html       the controller (phone)
web/js/input.js      turns raw sensor data into swings, tilts and twists
web/js/net.js        screen-side socket
web/js/arena.js      shared scene setup and the athlete rig
web/js/audio.js      all sound effects, synthesised at runtime
web/js/games/        one file per game
web/js/games/chess-rules.js   chess move generation + engine (perft-verified)
web/js/games/dame-rules.js    draughts move generation + engine
web/js/qr.js         QR encoder for the join address
web/lib/three.js     3D renderer
```

The phone streams accelerometer, gyroscope and orientation at about 60 Hz. The
server does no game logic at all — it only relays messages between phones and
screens, so all the physics runs on the PC where the frame rate is.

## Credits

3D rendering by [three.js](https://threejs.org) (MIT licence), vendored at
`web/lib/three.module.js` so the game runs with no network access at all.
Everything else — the server, the games, the physics, the sound, the QR
encoder — is written from scratch here and depends on nothing else.
