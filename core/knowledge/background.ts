/** Shared admission control: the interactive path never waits for background work. */
export class BackgroundBudget {
  private active = 0;
  private lastChat = 0;
  private controller = new AbortController();
  constructor(private cooldownMs = 1500) {}
  get paused() { return this.active > 0 || Date.now() - this.lastChat < this.cooldownMs; }
  get signal() { return this.controller.signal; }
  enterChat() {
    this.active++;
    this.controller.abort();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--; this.lastChat = Date.now();
      if (!this.active) this.controller = new AbortController();
    };
  }
}
