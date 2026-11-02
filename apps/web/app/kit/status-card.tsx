import type { CSSProperties, ReactNode } from "react";
import type { Tone } from "@/lib/kit/wait-band";

/**
 * A status card (2 Nov 2026, Cream pages 2a): one of the video's coloured
 * cards. A link when it has somewhere to go, a button when it opens into a
 * window, a plain card otherwise. Names people typed (customers, follow-ups)
 * stay on one line with an ellipsis and read in their own direction.
 */
export function StatusCard({
  tone,
  eyebrow,
  title,
  subtitle,
  figure,
  footer,
  href,
  onOpen,
  label,
  transitionName,
  className,
}: {
  tone: Tone;
  /** A small label above the title (a workflow step's tag, "AGENT 05"). */
  eyebrow?: string;
  title: string;
  subtitle?: string;
  figure?: string;
  footer?: ReactNode;
  href?: string;
  onOpen?: (card: HTMLElement) => void;
  /** The accessible name when the card is a link or a button. */
  label?: string;
  /** A view-transition-name, so the card can grow into its window. */
  transitionName?: string;
  className?: string;
}) {
  const cls = `kit-card tone-${tone}${className ? ` ${className}` : ""}`;
  const style: CSSProperties | undefined = transitionName ? ({ viewTransitionName: transitionName } as CSSProperties) : undefined;
  const inner = (
    <>
      {eyebrow ? <span className="kit-card-eyebrow">{eyebrow}</span> : null}
      <span className="kit-card-title" dir="auto">
        {title}
      </span>
      {subtitle ? (
        <span className="kit-card-sub" dir="auto">
          {subtitle}
        </span>
      ) : null}
      {figure ? <span className="kit-card-figure">{figure}</span> : null}
      {footer ? <span className="kit-card-foot">{footer}</span> : null}
    </>
  );
  if (href) {
    return (
      <a className={cls} href={href} aria-label={label} style={style}>
        {inner}
      </a>
    );
  }
  if (onOpen) {
    return (
      <button type="button" className={cls} aria-label={label} style={style} onClick={(event) => onOpen(event.currentTarget)}>
        {inner}
      </button>
    );
  }
  return (
    <div className={cls} style={style}>
      {inner}
    </div>
  );
}

/** Two initials in a round badge, with the full name for screen readers. */
export function Initials({ name }: { name: string | null }) {
  const letters = (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
  return (
    <span className="kit-initials" title={name ?? undefined} aria-label={name ?? undefined}>
      {letters || "?"}
    </span>
  );
}
