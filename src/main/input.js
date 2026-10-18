'use strict';
// 被控端：把主控端送來的滑鼠/鍵盤事件注入本機（nut-js）。
const { screen } = require('electron');

let nut = null;
let loadError = null;
try {
  nut = require('@nut-tree-fork/nut-js');
  nut.mouse.config.autoDelayMs = 0;
  nut.mouse.config.mouseSpeed = 100000;
  nut.keyboard.config.autoDelayMs = 0;
} catch (e) {
  loadError = e;
}

// KeyboardEvent.code → nut-js Key 名稱
const CODE_MAP = {
  Escape: 'Escape', Backquote: 'Grave', Minus: 'Minus', Equal: 'Equal', Backspace: 'Backspace',
  Tab: 'Tab', BracketLeft: 'LeftBracket', BracketRight: 'RightBracket', Backslash: 'Backslash',
  CapsLock: 'CapsLock', Semicolon: 'Semicolon', Quote: 'Quote', Enter: 'Enter',
  ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', Comma: 'Comma', Period: 'Period', Slash: 'Slash',
  ControlLeft: 'LeftControl', ControlRight: 'RightControl', AltLeft: 'LeftAlt', AltRight: 'RightAlt',
  MetaLeft: 'LeftSuper', MetaRight: 'RightSuper', Space: 'Space', ContextMenu: 'Menu',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  PrintScreen: 'Print', ScrollLock: 'ScrollLock', Pause: 'Pause', NumLock: 'NumLock',
  NumpadDivide: 'Divide', NumpadMultiply: 'Multiply', NumpadSubtract: 'Subtract', NumpadAdd: 'Add',
  NumpadEnter: 'Enter', NumpadDecimal: 'Decimal', NumpadEqual: 'NumPadEqual',
  AudioVolumeMute: 'AudioMute', AudioVolumeDown: 'AudioVolDown', AudioVolumeUp: 'AudioVolUp',
  MediaPlayPause: 'AudioPlay', MediaTrackNext: 'AudioNext', MediaTrackPrevious: 'AudioPrev',
};
for (let i = 0; i < 26; i++) { const c = String.fromCharCode(65 + i); CODE_MAP['Key' + c] = c; }
for (let i = 0; i <= 9; i++) { CODE_MAP['Digit' + i] = 'Num' + i; CODE_MAP['Numpad' + i] = 'NumPad' + i; }
for (let i = 1; i <= 24; i++) CODE_MAP['F' + i] = 'F' + i;

// 跨平台修飾鍵對應：Mac 的 ⌘ ↔ Windows 的 Ctrl
function translateCode(code, remoteOs, swapMods) {
  if (!swapMods || !remoteOs || remoteOs === process.platform) return code;
  if (remoteOs === 'darwin' && process.platform !== 'darwin') {
    if (code === 'MetaLeft') return 'ControlLeft';
    if (code === 'MetaRight') return 'ControlRight';
    if (code === 'ControlLeft') return 'MetaLeft';
    if (code === 'ControlRight') return 'MetaRight';
  }
  if (remoteOs !== 'darwin' && process.platform === 'darwin') {
    if (code === 'ControlLeft') return 'MetaLeft';
    if (code === 'ControlRight') return 'MetaRight';
    if (code === 'MetaLeft') return 'ControlLeft';
    if (code === 'MetaRight') return 'ControlRight';
  }
  return code;
}

function keyFor(code) {
  const name = CODE_MAP[code];
  if (!name || !nut) return undefined;
  return nut.Key[name];
}

const BUTTONS = ['LEFT', 'MIDDLE', 'RIGHT'];

class InputInjector {
  constructor(opts = {}) {
    this.dryRun = !!opts.dryRun;
    this.log = [];
    this.chain = Promise.resolve();
    this.pressed = new Set();
    this.buttons = new Set();
    this.displayId = null;
  }

  get available() { return !!nut; }
  get error() { return loadError ? String(loadError.message || loadError) : null; }

  setDisplay(id) { this.displayId = id; }

  display() {
    const all = screen.getAllDisplays();
    return all.find((d) => String(d.id) === String(this.displayId)) || screen.getPrimaryDisplay();
  }

  // 正規化座標 (0~1) → 本機螢幕座標
  toScreenPoint(nx, ny) {
    const d = this.display();
    const b = d.bounds;
    const x = Math.round(b.x + Math.min(Math.max(nx, 0), 0.9999) * b.width);
    const y = Math.round(b.y + Math.min(Math.max(ny, 0), 0.9999) * b.height);
    if (process.platform === 'win32' && screen.dipToScreenPoint) return screen.dipToScreenPoint({ x, y });
    return { x, y };
  }

  enqueue(fn) {
    this.chain = this.chain.then(fn).catch((e) => { this.log.push('error ' + e.message); });
    return this.chain;
  }

  handle(ev, remoteOs, swapMods) {
    if (this.dryRun) { this.log.push(JSON.stringify(ev)); if (this.log.length > 500) this.log.shift(); return; }
    if (!nut) return;
    const { mouse, keyboard, Button, Point } = nut;
    switch (ev.t) {
      case 'mm': {
        const p = this.toScreenPoint(ev.x, ev.y);
        return this.enqueue(() => mouse.setPosition(new Point(p.x, p.y)));
      }
      case 'md':
      case 'mu': {
        const btn = Button[BUTTONS[ev.b] || 'LEFT'];
        const p = ev.x != null ? this.toScreenPoint(ev.x, ev.y) : null;
        return this.enqueue(async () => {
          if (p) await mouse.setPosition(new Point(p.x, p.y));
          if (ev.t === 'md') { this.buttons.add(btn); await mouse.pressButton(btn); }
          else { this.buttons.delete(btn); await mouse.releaseButton(btn); }
        });
      }
      case 'wheel': {
        const steps = (v) => Math.max(1, Math.min(15, Math.round(Math.abs(v) / (process.platform === 'darwin' ? 20 : 40))));
        return this.enqueue(async () => {
          if (ev.dy > 0) await mouse.scrollDown(steps(ev.dy));
          else if (ev.dy < 0) await mouse.scrollUp(steps(ev.dy));
          if (ev.dx > 0) await mouse.scrollRight(steps(ev.dx));
          else if (ev.dx < 0) await mouse.scrollLeft(steps(ev.dx));
        });
      }
      case 'kd':
      case 'ku': {
        const key = keyFor(translateCode(ev.code, remoteOs, swapMods));
        if (key === undefined) return;
        return this.enqueue(async () => {
          if (ev.t === 'kd') { this.pressed.add(key); await keyboard.pressKey(key); }
          else { this.pressed.delete(key); await keyboard.releaseKey(key); }
        });
      }
      case 'combo': { // 例如 Win 鍵、Ctrl+Shift+Esc
        const keys = ev.codes.map((c) => keyFor(ev.raw ? c : translateCode(c, remoteOs, swapMods))).filter((k) => k !== undefined);
        if (!keys.length) return;
        return this.enqueue(async () => { await keyboard.pressKey(...keys); await keyboard.releaseKey(...keys); });
      }
      default:
    }
  }

  // 斷線時放開所有按住的鍵，避免卡住
  releaseAll() {
    if (!nut || this.dryRun) return;
    const keys = [...this.pressed];
    const btns = [...this.buttons];
    this.pressed.clear();
    this.buttons.clear();
    this.enqueue(async () => {
      for (const k of keys) await nut.keyboard.releaseKey(k);
      for (const b of btns) await nut.mouse.releaseButton(b);
    });
  }
}

module.exports = { InputInjector, CODE_MAP, translateCode };
