/**
 * The kit (Cream pages 2a): the shared pieces, from one import. A page also
 * imports "@/app/kit/kit.css" itself, as every page imports its stylesheet:
 * a stylesheet imported here would break the render tests, which load these
 * modules outside Next.
 */

export { NumberTile } from "./number-tile";
export { StatusCard, Initials } from "./status-card";
export { ChartCard } from "./chart-card";
export { AreaChart, LineChart, BarChart, type Point, type Bar } from "./charts";
export { CardWindow, openFromCard } from "./card-window";
export { SlidePanel } from "./slide-panel";
export { BoardColumn, BoardCard, useBoardDrag, type CardHandlers } from "./board";
