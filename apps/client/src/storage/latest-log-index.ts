import type { WorkoutSet } from '../types';
/** Indexed max heap: edits/removals of the newest set remain logarithmic in history size. */
export class LatestLogIndex {
    private heap: WorkoutSet[] = [];
    private positions = new Map<string, number>();
    clear() { this.heap = []; this.positions.clear(); }
    get() { return this.heap[0]; }
    private newer(left: WorkoutSet, right: WorkoutSet) {
        const difference = Date.parse(left.date) - Date.parse(right.date);
        return difference > 0 || (difference === 0 && left.id > right.id);
    }
    private swap(a: number, b: number) {
        [this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]];
        this.positions.set(this.heap[a].id, a); this.positions.set(this.heap[b].id, b);
    }
    private balance(index: number) {
        while (index > 0) {
            const parent = (index - 1) >>> 1;
            if (!this.newer(this.heap[index], this.heap[parent])) break;
            this.swap(index, parent); index = parent;
        }
        for (;;) {
            let next = index;
            for (const child of [index * 2 + 1, index * 2 + 2]) {
                if (child < this.heap.length && this.newer(this.heap[child], this.heap[next])) next = child;
            }
            if (next === index) break;
            this.swap(index, next); index = next;
        }
    }
    put(id: string, log?: WorkoutSet) {
        const index = this.positions.get(id);
        const valid = log && !log.isDeleted && typeof log.date === 'string' && Number.isFinite(Date.parse(log.date));
        if (index !== undefined) {
            if (valid) this.heap[index] = log;
            else {
                const last = this.heap.pop()!;
                this.positions.delete(id);
                if (index === this.heap.length) return;
                this.heap[index] = last; this.positions.set(last.id, index);
            }
            this.balance(index);
        } else if (valid) {
            this.positions.set(id, this.heap.length); this.heap.push(log); this.balance(this.heap.length - 1);
        }
    }
}
