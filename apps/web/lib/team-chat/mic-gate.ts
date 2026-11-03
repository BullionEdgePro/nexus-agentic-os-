/**
 * Which request for the microphone is still wanted (2 Nov 2026, final review).
 *
 * Opening the microphone is asynchronous, and the first time it waits on the
 * browser's permission question. Meanwhile the press can end (too short), a new
 * press can start, or the person can leave the chat. Each request takes a
 * ticket; when its microphone finally opens, `keep` hands it back only if that
 * ticket is still the current one and the recorder is still on screen —
 * otherwise it stops the microphone there and then, so the phone's mic light
 * never stays on for a recording nobody is making. Pure.
 */
type Stream = { getTracks: () => Array<{ stop: () => void }> };

export class MicGate {
  private ticket = 0;
  private closed = false;

  /** A new request for the microphone; earlier ones stop being wanted. */
  begin(): number {
    this.ticket += 1;
    return this.ticket;
  }

  /** The current request is no longer wanted (the press ended, was cancelled…). */
  cancel(): void {
    this.ticket += 1;
  }

  /**
   * The recorder is on screen (again). React mounts, unmounts and mounts once
   * more in development; a request made before the unmount stays unwanted.
   */
  open(): void {
    this.closed = false;
  }

  /** The recorder left the screen: nothing it asked for is wanted any more. */
  close(): void {
    this.closed = true;
    this.ticket += 1;
  }

  /** The stream if its request is still wanted; otherwise it is stopped and null. */
  keep<S extends Stream>(ticket: number, stream: S): S | null {
    if (!this.closed && ticket === this.ticket) return stream;
    stream.getTracks().forEach((t) => t.stop());
    return null;
  }
}
