/** Local promise ownership only; endpoint and physical peer closure are separate. */
export function createPendingWork() {
  const pending = new Set();
  const track = (promise) => {
    const task = Promise.resolve(promise);
    pending.add(task);
    const remove = () => pending.delete(task);
    void task.then(remove, remove);
    return task;
  };
  return {
    track,
    run: (body) => track(Promise.resolve().then(body)),
    async drain() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
