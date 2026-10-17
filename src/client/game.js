import { clamp } from '../shared/protocol.js';
export const WIDTH = 1200, HEIGHT = 480;
export const SHAPES = [
  { shape: 'circle', label: 'まる', color: '#e5a04b', start: [190, 160], target: [965, 300] },
  { shape: 'triangle', label: 'さんかく', color: '#a5b7a0', start: [320, 340], target: [1020, 135] },
  { shape: 'square', label: 'しかく', color: '#a7b8d7', start: [430, 160], target: [810, 350] }
];

export class Game {
  constructor(mode = 'shapes') { this.reset(mode); }
  reset(mode = this.mode) {
    this.mode = mode; this.active = 0; this.done = false; this.moves = 0;
    this.pieces = SHAPES.map(s => ({ ...s, x: s.start[0], y: s.start[1], placed: false }));
    this.cursor = mode === 'shapes' ? { x: SHAPES[0].start[0], y: SHAPES[0].start[1] } : { x: WIDTH / 2, y: HEIGHT / 2 };
    this.closed = false; this.held = null; this.grabOrigin = null;
    this.contactId = 0; this.feedback = { text: '', kind: 'contact' };
    this.gridWidth = 120; this.gridHeight = 48;
    this.cleaned = new Uint8Array(this.gridWidth * this.gridHeight);
    this.cleanCount = 0; this.lastInput = null;
    this.event = { text: mode === 'shapes' ? '図形の上で着地すると、手をにぎってつかみます。' : 'スマホを平らにして、机を拭くように動かす。', kind: 'info' };
  }
  releaseHand() { this.closed = false; this.held = null; this.grabOrigin = null; }
  baseline(input = null) { this.lastInput = input; this.releaseHand(); }
  nearest() {
    let best = -1, distance = 105;
    this.pieces.forEach((p, i) => {
      const d = Math.hypot(this.cursor.x - p.x, this.cursor.y - p.y);
      if (!p.placed && d < distance) { best = i; distance = d; }
    });
    return best;
  }
  apply(input) {
    const previous = this.lastInput;
    this.lastInput = input;
    if (!previous || input.epoch !== previous.epoch || input.status !== 'ready' || previous.status !== 'ready') { this.releaseHand(); return; }
    if (this.done) return;
    const dx = clamp(input.x - previous.x, -WIDTH, WIDTH), dy = clamp(input.y - previous.y, -HEIGHT, HEIGHT);
    const old = { ...this.cursor };
    this.cursor.x = clamp(this.cursor.x + dx, 0, WIDTH); this.cursor.y = clamp(this.cursor.y + dy, 0, HEIGHT);
    if (this.mode === 'shapes') {
      if (this.held !== null) {
        const p = this.pieces[this.held];
        p.x = clamp(p.x + this.cursor.x - old.x, 48, WIDTH - 48);
        p.y = clamp(p.y + this.cursor.y - old.y, 48, HEIGHT - 48);
      }
    } else {
      if (Math.hypot(dx, dy) > 0.4 && (input.moving || previous.moving)) this.erase(old, this.cursor);
      if (this.progress >= 95) { this.done = true; this.event = { text: 'すっきり、きれい。', kind: 'success' }; }
    }
    if (input.land > previous.land && input.landing === 'impact') {
      const contacts = input.land - previous.land;
      // Multiple contacts in one sampled frame preserve hand parity; do not
      // invent object interactions at unobserved intermediate positions.
      if (contacts % 2 === 1 || this.mode === 'clean') this.contact();
    }
  }
  contact() {
    this.contactId++;
    if (this.mode === 'clean') { this.feedback = { text: '着地を検出', kind: 'contact' }; return; }
    if (!this.closed) {
      this.closed = true;
      const index = this.nearest();
      this.held = index < 0 ? null : index;
      this.grabOrigin = this.held === null ? null : { x: this.pieces[index].x, y: this.pieces[index].y };
      this.feedback = { text: index < 0 ? '着地 → にぎる（空の手）' : `着地 → ${this.pieces[index].label}をつかむ`, kind: 'grab' };
      this.event = { text: index < 0 ? '近くに図形がありません。次の着地で手を開きます。' : 'つかみました。穴へ動かし、次の着地で離します。', kind: 'info' };
    } else {
      const index = this.held, origin = this.grabOrigin;
      this.releaseHand();
      this.feedback = { text: '着地 → 手をひらく', kind: 'release' };
      if (index === null) { this.event = { text: '手を開きました。図形の上で着地してつかみます。', kind: 'info' }; return; }
      const p = this.pieces[index]; this.moves++;
      const tx = p.target[0] - origin.x, ty = p.target[1] - origin.y;
      const mx = p.x - origin.x, my = p.y - origin.y;
      const distance = Math.hypot(tx, ty);
      const projection = (mx * tx + my * ty) / Math.max(distance, 1);
      const perpendicular = Math.abs(mx * ty - my * tx) / Math.max(distance, 1);
      const close = Math.hypot(p.x - p.target[0], p.y - p.target[1]) < 145;
      const roughMatch = projection > Math.max(35, distance * 0.30) && projection < distance * 1.8 && perpendicular < Math.max(95, distance * 0.48);
      if (close || roughMatch) {
        p.x = p.target[0]; p.y = p.target[1]; p.placed = true;
        this.active++; this.done = this.active === this.pieces.length;
        this.feedback = { text: `着地 → 離す → ${p.label}、ぴったり！`, kind: 'success' };
        this.event = { text: this.done ? '全部、ぴったり。' : '置けました。手を動かし、次の図形を着地でつかみます。', kind: 'success' };
      } else this.event = { text: 'ここで離しました。もう一度着地でつかみ、穴の方向へ。', kind: 'retry' };
    }
  }
  erase(from, to) {
    const radius = 66, steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 12));
    for (let step = 0; step <= steps; step++) {
      const x = from.x + (to.x - from.x) * step / steps, y = from.y + (to.y - from.y) * step / steps;
      for (let gy = Math.max(0, Math.floor((y - radius) / 10)); gy < Math.min(this.gridHeight, Math.ceil((y + radius) / 10)); gy++) {
        for (let gx = Math.max(0, Math.floor((x - radius) / 10)); gx < Math.min(this.gridWidth, Math.ceil((x + radius) / 10)); gx++) {
          if ((gx * 10 + 5 - x) ** 2 + (gy * 10 + 5 - y) ** 2 <= radius ** 2) {
            const i = gy * this.gridWidth + gx;
            if (!this.cleaned[i]) { this.cleaned[i] = 1; this.cleanCount++; }
          }
        }
      }
    }
  }
  get progress() { return this.mode === 'shapes' ? this.active / 3 * 100 : this.cleanCount / this.cleaned.length * 100; }
}
