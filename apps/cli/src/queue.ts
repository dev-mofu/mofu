/**
 * Runs async tasks one at a time, in call order. The model can call several
 * tools in parallel, but the terminal can only ask one y/n question at once.
 */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task);
    // A failed task must not block the ones after it.
    tail = run.catch(() => undefined);
    return run;
  };
}
