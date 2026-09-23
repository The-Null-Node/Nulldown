/** Comparator that returns a positive value when `a` has higher priority than `b`. */
export type CompareFn<T> = (a: T, b: T) => number;

/**
 * Bounded max-priority queue used to retain the newest/highest-priority items.
 *
 * `push` and `setMaxSize` return items evicted by the size cap so callers can
 * keep auxiliary indexes in sync with the bounded heap.
 */
export default class MaxPriorityQueue<T> {
  private items: T[] = [];
  private maxSize: number;
  private compare: CompareFn<T>;

  /** Creates a queue with a caller-provided comparator and positive size cap. */
  constructor(compare: CompareFn<T>, maxSize = 3) {
    this.compare = compare;
    this.maxSize = Math.max(1, maxSize);
  }

  /** Returns the number of items currently retained. */
  size(): number {
    return this.items.length;
  }

  /** Returns the highest-priority item without removing it. */
  peek(): T | null {
    return this.items[0] ?? null;
  }

  /** Returns a shallow copy of retained items in heap order. */
  toArray(): T[] {
    return [...this.items];
  }

  /** Updates the size cap and returns any items evicted by trimming. */
  setMaxSize(maxSize: number): T[] {
    this.maxSize = Math.max(1, maxSize);
    return this.trim();
  }

  /** Adds an item and returns any lower-priority items evicted by the cap. */
  push(item: T): T[] {
    this.items.push(item);
    this.heapifyUp(this.items.length - 1);
    return this.trim();
  }

  /** Removes and returns the highest-priority item. */
  pop(): T | null {
    if (!this.items.length) return null;
    if (this.items.length === 1) return this.items.pop() ?? null;
    const top = this.items[0];
    this.items[0] = this.items.pop() as T;
    this.heapifyDown(0);
    return top;
  }

  private trim(): T[] {
    const removed: T[] = [];
    while (this.items.length > this.maxSize) {
      const minIndex = this.findMinIndex();
      const [evicted] = this.removeAt(minIndex);
      if (evicted) {
        removed.push(evicted);
      }
    }
    return removed;
  }

  private findMinIndex(): number {
    let minIndex = 0;
    for (let i = 1; i < this.items.length; i += 1) {
      if (this.compare(this.items[i], this.items[minIndex]) < 0) {
        minIndex = i;
      }
    }
    return minIndex;
  }

  private removeAt(index: number): T[] {
    if (index < 0 || index >= this.items.length) return [];
    const removed = this.items[index];
    const last = this.items.pop();

    if (last === undefined || index === this.items.length) {
      return [removed];
    }

    this.items[index] = last;

    if (
      index > 0 &&
      this.compare(this.items[index], this.items[this.parentIndex(index)]) > 0
    ) {
      this.heapifyUp(index);
    } else {
      this.heapifyDown(index);
    }
    return [removed];
  }

  private heapifyUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = this.parentIndex(current);
      if (this.compare(this.items[current], this.items[parent]) <= 0) {
        break;
      }
      this.swap(current, parent);
      current = parent;
    }
  }

  private heapifyDown(index: number): void {
    let current = index;
    while (true) {
      const left = this.leftIndex(current);
      const right = this.rightIndex(current);
      let largest = current;

      if (
        left < this.items.length &&
        this.compare(this.items[left], this.items[largest]) > 0
      ) {
        largest = left;
      }
      if (
        right < this.items.length &&
        this.compare(this.items[right], this.items[largest]) > 0
      ) {
        largest = right;
      }
      if (largest === current) {
        break;
      }
      this.swap(current, largest);
      current = largest;
    }
  }

  private parentIndex(index: number): number {
    return Math.floor((index - 1) / 2);
  }

  private leftIndex(index: number): number {
    return index * 2 + 1;
  }

  private rightIndex(index: number): number {
    return index * 2 + 2;
  }

  private swap(a: number, b: number): void {
    const temp = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = temp;
  }
}
