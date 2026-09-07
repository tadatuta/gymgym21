/** Own DOM subscriptions for a mounted page. Reusable after a render, idempotent
 * on disposal; detached controls are released after partial updates too. */
export function createLifecycle() {
  const subscriptions = new Set<{ target: EventTarget; dispose(): void }>();
  function listen<K extends keyof HTMLElementEventMap>(target: EventTarget | null | undefined, type: K, handler: (event: HTMLElementEventMap[K]) => void): void;
  function listen(target: EventTarget | null | undefined, type: string, handler: (event: Event) => void): void;
  function listen(target: EventTarget | null | undefined, type: string, handler: (event: never) => void) {
    if (!target) return;
    const listener = handler as EventListener;
    target.addEventListener(type, listener);
    subscriptions.add({ target, dispose: () => target.removeEventListener(type, listener) });
  }
  function sweep() {
    for (const subscription of subscriptions) {
      if (subscription.target instanceof Node && !subscription.target.isConnected) {
        subscription.dispose();
        subscriptions.delete(subscription);
      }
    }
  }
  return {
    listen, sweep, own(target: Node, dispose: () => void) {
      subscriptions.add({ target, dispose });
    }, dispose() {
      subscriptions.forEach(subscription => subscription.dispose());
      subscriptions.clear();
    }
  };
}
