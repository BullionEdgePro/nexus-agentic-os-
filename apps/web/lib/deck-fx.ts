// Command-deck visual effects: custom cursor + animated ribbon backdrop.
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
      let mx = window.innerWidth / 2,
        my = window.innerHeight / 2,
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
    const ribbons = Array.from({ length: 5 }, (_, i) => ({
      o: i * 1.3,
      a: 60 + i * 26,
      sp: 0.0007 + i * 0.00016,
      y: 0.28 + i * 0.11,
      hue: 200 + i * 8,
    }));
    const parts = Array.from({ length: 60 }, () => ({
      x: Math.random(),
      y: Math.random(),
      z: Math.random() * 0.8 + 0.2,
      s: Math.random() * 0.0004 + 0.0001,
    }));
    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";
      ribbons.forEach((r) => {
        ctx.beginPath();
        for (let x = -40; x <= W + 40; x += 14) {
          const y =
            H * r.y +
            Math.sin(x * 0.0032 + t * r.sp * 1000 + r.o) * r.a +
            Math.sin(x * 0.0011 - t * r.sp * 600) * r.a * 0.5;
          x === -40 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        const g = ctx.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0, "rgba(47,109,255,0)");
        g.addColorStop(0.5, `hsla(${r.hue},100%,62%,.16)`);
        g.addColorStop(1, "rgba(56,224,255,0)");
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.4;
        ctx.stroke();
      });
      parts.forEach((pt) => {
        pt.x += pt.s;
        if (pt.x > 1.05) pt.x = -0.05;
        const px = pt.x * W,
          py = pt.y * H + Math.sin(t * 0.5 + pt.y * 10) * 8;
        ctx.beginPath();
        ctx.arc(px, py, pt.z * 1.6, 0, 6.28);
        ctx.fillStyle = `rgba(120,180,255,${pt.z * 0.4})`;
        ctx.fill();
      });
      ctx.globalCompositeOperation = "source-over";
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
