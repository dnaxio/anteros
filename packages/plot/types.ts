/** Supported rendering engines */
export type DriverType = "echarts" | "observable";

// ─── Mark descriptor (abstract, driver-agnostic) ─────────────────────

/** Options for a single mark */
export interface MarkOptions {
  /** X-axis / name field */
  x?: string;
  /** Y-axis / value field */
  y?: string;
  /** Image URL or field name containing URLs (image mark) */
  src?: string;
  /** Image width in pixels (image mark) */
  width?: number;
  /** Image height in pixels (image mark) */
  height?: number;
  /** Border radius in pixels (image, bar marks) */
  r?: number;
  /** Links/edges for network mark: [{source, target}, ...] */
  links?: { source: string; target: string; value?: number }[];
  /** Value/intensity field for heatmap color mapping */
  value?: string;
  /** Color scheme for heatmap (e.g. "viridis", "warm", "turbo") */
  colorScheme?: string;
  /** Text field or content (text mark) */
  text?: string;
  /** Vertical offset in px (text mark) */
  dy?: number;
  /** Horizontal offset in px (text mark) */
  dx?: number;
  /** Text anchor (text mark): "start", "middle", "end" */
  textAnchor?: "start" | "middle" | "end";
  /** Vertical text anchor (text mark): "top", "bottom", "middle" */
  lineAnchor?: "top" | "bottom" | "middle";
  /** Font family (text mark) */
  fontFamily?: string;
  /** Font weight (text mark): "normal", "bold", etc. */
  fontWeight?: string | number;
  /** Font style (text mark): "normal", "italic" */
  fontStyle?: string;
  /** Enable/disable tooltip for this mark (default: true) */
  tip?: boolean;
  /** Tooltip text field — displays this column's value on hover */
  title?: string;
  /** Font size in px (text mark) */
  fontSize?: number;
  /** Fill color (bar, pie, scatter). If unset, driver auto-assigns from its palette. */
  fill?: string;
  /** Stroke color (line, scatter). If unset, driver auto-assigns from its palette. */
  stroke?: string;
  /** Smooth line interpolation */
  smooth?: boolean;
  /** Show point symbols on lines */
  showSymbol?: boolean;
  /** Show background grid on bars */
  showBackground?: boolean;
  /** Series / legend name override */
  name?: string;
  /** Driver-specific passthrough */
  [key: string]: unknown;
}

/** Abstract mark produced by Plot.barX(), Plot.barY(), Plot.line(), etc. */
export interface Mark {
  type: "barX" | "barY" | "line" | "pie" | "scatter" | "dot" | "image" | "tree" | "network" | "heatmap" | "text";
  data: Record<string, unknown>[];
  options: MarkOptions;
}

// ─── Axis config ──────────────────────────────────────────────────────

/** Configuration for a single axis (x or y). Mirrors Observable Plot's API. */
export interface AxisConfig {
  /** Axis label / title */
  label?: string;
  /** Show grid lines */
  grid?: boolean;
  /** Domain [min, max] — only for value axes */
  domain?: [number, number];
  /** Tick label rotation in degrees */
  tickRotate?: number;
  /** Scale type override */
  type?: "linear" | "log" | "band";
  /** Round domain to nice round numbers */
  nice?: boolean;
  /** Force domain to include zero */
  zero?: boolean;
  tickFormat?: string;
  /** Driver-specific passthrough */
  [key: string]: unknown;
}

// ─── Plot options ────────────────────────────────────────────────────

/** Known options for Plot.plot(). Extended via index signature for passthrough. */
export interface PlotOptions {
  /** Rendering engine (default: "echarts") */
  driver?: DriverType;
  /** DOM target element */
  target: HTMLElement;
  /** Marks to render (composed on the same chart) */
  marks: Mark[];
  /** Theme (ECharts only) */
  theme?: "dark" | "default";
  /** Chart title */
  title?: string;
  /** CSS width */
  width?: string;
  /** CSS height (default: "400px") */
  height?: string;
  /** Show legend (default: false). Auto-generated from mark names. */
  legend?: boolean;
  /** Color scale config. Observable: {scheme, type, domain, range}. ECharts: palette array or scheme name. */
  color?: string[] | { scheme?: string; type?: string; legend?: boolean; domain?: unknown[]; range?: string[] };
  /** X-axis configuration (label, grid, domain, etc.) */
  x?: AxisConfig;
  /** Y-axis configuration */
  y?: AxisConfig;
  /** Driver-specific passthrough */
  [key: string]: unknown;
}
