/**
 * Flat binary min-heap over (priority, payload) pairs stored in parallel typed
 * arrays. Used by the depression-filling priority flood and by road A*, both of
 * which push millions of entries and cannot afford per-node objects.
 */
export class MinHeap {
  private prio: Float64Array;
  private item: Int32Array;
  private n = 0;

  constructor(capacity = 1024) {
    this.prio = new Float64Array(Math.max(16, capacity));
    this.item = new Int32Array(Math.max(16, capacity));
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.n = 0;
  }

  private grow(): void {
    const cap = this.prio.length * 2;
    const p = new Float64Array(cap);
    const it = new Int32Array(cap);
    p.set(this.prio);
    it.set(this.item);
    this.prio = p;
    this.item = it;
  }

  push(priority: number, payload: number): void {
    if (this.n === this.prio.length) this.grow();
    let i = this.n++;
    const prio = this.prio;
    const item = this.item;
    prio[i] = priority;
    item[i] = payload;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (prio[parent] <= prio[i]) break;
      const tp = prio[parent];
      prio[parent] = prio[i];
      prio[i] = tp;
      const ti = item[parent];
      item[parent] = item[i];
      item[i] = ti;
      i = parent;
    }
  }

  /** Priority of the current minimum. Undefined behaviour when empty. */
  peekPriority(): number {
    return this.prio[0];
  }

  /** Returns the payload of the minimum and removes it. Returns -1 when empty. */
  pop(): number {
    if (this.n === 0) return -1;
    const prio = this.prio;
    const item = this.item;
    const top = item[0];
    this.n--;
    if (this.n > 0) {
      prio[0] = prio[this.n];
      item[0] = item[this.n];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.n && prio[l] < prio[m]) m = l;
        if (r < this.n && prio[r] < prio[m]) m = r;
        if (m === i) break;
        const tp = prio[m];
        prio[m] = prio[i];
        prio[i] = tp;
        const ti = item[m];
        item[m] = item[i];
        item[i] = ti;
        i = m;
      }
    }
    return top;
  }
}
