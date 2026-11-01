/**
 * Whether the page or app is in use, for the head probe timer.
 * Probes refresh heads for calls the user is about to make. A hidden tab or a backgrounded app makes none,
 * and its probes would spend the provider's rate limit for nothing.
 * @module
 */

/** The part of a browser `document` this module reads. */
interface VisibilityDocument {
  visibilityState: string;
  addEventListener: (type: "visibilitychange", listener: () => void) => void;
  removeEventListener: (type: "visibilitychange", listener: () => void) => void;
}

/** The browser document, read at call time. Undefined on Workers, Node, Bun, and React Native. */
function visibilityDocument(): VisibilityDocument | undefined {
  const document: unknown = (globalThis as { document?: unknown }).document;
  if (typeof document !== "object" || document === null) return undefined;
  const candidate = document as Partial<VisibilityDocument>;
  if (typeof candidate.visibilityState !== "string") return undefined;
  if (typeof candidate.addEventListener !== "function" || typeof candidate.removeEventListener !== "function") {
    return undefined;
  }
  return candidate as VisibilityDocument;
}

/** Default `isActive`: false only in a browser whose page is hidden. */
export function defaultIsActive(): boolean {
  return visibilityDocument()?.visibilityState !== "hidden";
}

/** One instance's view of activity, and its `visibilitychange` listener while the probe timer runs. */
export class Activity {
  readonly #isActive: () => boolean;
  #stop: (() => void) | undefined;

  constructor(isActive: (() => boolean) | undefined) {
    this.#isActive = isActive ?? defaultIsActive;
  }

  /** The caller's hook, or the page's visibility. A hook that throws counts as active, so probes keep running. */
  active(): boolean {
    try {
      return this.#isActive() !== false;
    } catch {
      return true;
    }
  }

  /**
   * Call `onChange` on every `visibilitychange` until {@link unwatch}. Without a browser document it does nothing.
   * A second call while watching keeps the first listener.
   */
  watch(onChange: () => void): void {
    if (this.#stop) return;
    const document = visibilityDocument();
    if (!document) return;
    document.addEventListener("visibilitychange", onChange);
    this.#stop = (): void => document.removeEventListener("visibilitychange", onChange);
  }

  unwatch(): void {
    const stop = this.#stop;
    this.#stop = undefined;
    stop?.();
  }
}
