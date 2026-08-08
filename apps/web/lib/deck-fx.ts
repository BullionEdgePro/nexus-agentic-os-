// Command-deck visual effects: custom cursor + a faint animated schematic
// backdrop (thin ink trace lines + small square "solder point" marks — the
// "routing plate" motif, kept ambient rather than decorative).
// Called from a useEffect; returns a cleanup that removes every listener and
// cancels animation frames so React unmounts don't leak.

export function initDeckFx(root: HTMLElement): () => void {
  const cleanups: Array<() => void> = [];
  const reduce = matchMedia("(prefers-reduced-motion:reduce)").matches;

  /* ---- custom cursor ---- */
  if (matchMedia("(pointer:fine)").matches) {
    const dot = root.querySelector<HTMLElement>(".cur-dot");
    const ring = root.querySelector<HTMLElement>(".cur-ring");
    if (dot && ring) {
      // Tell the stylesheet the replacement cursor is really here. `cursor:
      // none` is keyed off this class, so a page that borrows .deck-root for
      // its theme tokens without mounting these effects keeps its normal mouse
      // pointer instead of losing it — which is what happened to /deck/team:
      // the native cursor was hidden and nothing was drawn in its place, so the
      // page looked perfectly fine and the mouse simply vanished.
      root.classList.add("fx-cursor");

      // Start off-screen so the ring doesn't flash at viewport-center before
      // the first real mousemove.
      let mx = -100,
        my = -100,
        rx = mx,
        ry = my,
        raf = 0;
      const move = (e: MouseEvent) => {
        mx = e.clientX;
        my = e.clientY;
        dot.style.transform = `translate(${mx}px,${my}px) translate(-50%,-50%)`;
      };
      const down = () => ring.classList.add("press");
      const up = () => ring.classList.remove("press");
      const hot = () => ring.classList.add("hot");
      const cold = () => ring.classList.remove("hot");
      document.addEventListener("mousemove", move);
      document.addEventListener("mousedown", down);
      document.addEventListener("mouseup", up);
      const interactive = Array.from(
        root.querySelectorAll("a,button,input,.node,.tenant-switch,.stat,label")
      );
      interactive.forEach((el) => {
        el.addEventListener("mouseenter", hot);
        el.addEventListener("mouseleave", cold);
      });
      const loop = () => {
        rx += (mx - rx) * 0.18;
        ry += (my - ry) * 0.18;
        ring.style.transform = `translate(${rx}px,${ry}px) translate(-50%,-50%)`;
        raf = requestAnimationFrame(loop);
      };
      loop();
      cleanups.push(() => {
        // Restore the native cursor before the replacement stops being drawn,
        // or a React unmount leaves the pointer invisible.
        root.classList.remove("fx-cursor");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mousedown", down);
        document.removeEventListener("mouseup", up);
        interactive.forEach((el) => {
          el.removeEventListener("mouseenter", hot);
          el.removeEventListener("mouseleave", cold);
        });
        cancelAnimationFrame(raf);
      });
    }
  }

  /* ---- backdrop ribbons ---- */
  const cv = root.querySelector<HTMLCanvasElement>("canvas.bg");
  const ctx = cv?.getContext("2d");
  if (cv && ctx) {
    let W = 0,
      H = 0,
      t = 0,
      raf = 0;
    const size = () => {
      W = cv.width = window.innerWidth;
      H = cv.height = window.innerHeight;
    };
    size();
    window.addEventListener("resize", size);
    const traces = Array.from({ length: 5 }, (_, i) => ({
      o: i * 1.3,
      a: 50 + i * 20,
      sp: 0.0007 + i * 0.00016,
      y: 0.24 + i * 0.13,
    }));
    const marks = Array.from({ length: 46 }, () => ({
      x: Math.random(),
      y: Math.random(),
      z: Math.random() * 0.7 + 0.3,
      s: Math.random() * 0.0003 + 0.00008,
    }));
    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      // thin ink trace lines — flat, low-alpha, no glow blending
      traces.forEach((r) => {
        ctx.beginPath();
        for (let x = -40; x <= W + 40; x += 16) {
          const y =
            H * r.y +
            Math.sin(x * 0.0032 + t * r.sp * 1000 + r.o) * r.a +
            Math.sin(x * 0.0011 - t * r.sp * 600) * r.a * 0.5;
          x === -40 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "rgba(22,22,15,.05)";
        ctx.lineWidth = 1;
        ctx.stroke();
      });
      // small square "solder point" marks along the traces
      marks.forEach((pt) => {
        pt.x += pt.s;
        if (pt.x > 1.05) pt.x = -0.05;
        const px = pt.x * W,
          py = pt.y * H + Math.sin(t * 0.5 + pt.y * 10) * 8,
          sz = pt.z * 2.2;
        ctx.strokeStyle = `rgba(29,63,191,${pt.z * 0.22})`;
        ctx.lineWidth = 1;
        ctx.strokeRect(px - sz / 2, py - sz / 2, sz, sz);
      });
      if (!reduce) t += 1;
      raf = requestAnimationFrame(draw);
    };
    draw();
    cleanups.push(() => {
      window.removeEventListener("resize", size);
      cancelAnimationFrame(raf);
    });
  }

  return () => cleanups.forEach((fn) => fn());
}
