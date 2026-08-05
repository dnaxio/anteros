import type { Mark, MarkOptions, PlotOptions, AxisConfig, DriverType } from "./types";
import { EChartsDriver } from "./drivers/echarts";
import { ObservableDriver } from "./drivers/observable";

// ─── Mark factories ──────────────────────────────────────────────────

/** Create a horizontal bar mark (x = quantitative, y = ordinal) */
export function barX(
  data: Record<string, unknown>[],
  options: MarkOptions = {},
): Mark {
  return { type: "barX", data, options };
}

/** Create a vertical bar mark (x = ordinal, y = quantitative) */
export function barY(
  data: Record<string, unknown>[],
  options: MarkOptions = {},
): Mark {
  return { type: "barY", data, options };
}

/** Create a line mark */
export function line(
  data: Record<string, unknown>[],
  options: MarkOptions = {},
): Mark {
  return { type: "line", data, options };
}

/** Create a pie mark */
export function pie(
  data: Record<string, unknown>[],
  options: MarkOptions = {},
): Mark {
  return { type: "pie", data, options };
}

/** Create a scatter / dot mark */
export function scatter(
  data: Record<string, unknown>[],
  options: MarkOptions = {},
): Mark {
  return { type: "scatter", data, options };
}

/** Create a dot mark (alias for scatter). Observable Plot naming. */
export function dot(
  data: Record<string, unknown>[],
  options: MarkOptions = {},
): Mark {
  return { type: "dot", data, options };
}

/** Create an image mark (renders images at data positions) */
export function image(
  data: Record<string, unknown>[],
  options: MarkOptions = {},
): Mark {
  return { type: "image", data, options };
}

/** Create a tree / hierarchy mark */
export function tree(
  data: Record<string, unknown>[],
  options: MarkOptions = {},
): Mark {
  return { type: "tree", data, options };
}

/** Create a network / graph mark (nodes + edges) */
export function network(
  data: Record<string, unknown>[],
  options: MarkOptions = {},
): Mark {
  return { type: "network", data, options };
}

/** Create a heatmap mark */
export function heatmap(
  data: Record<string, unknown>[],
  options: MarkOptions = {},
): Mark {
  return { type: "heatmap", data, options };
}

/** Create a text label mark */
export function text(
  data: Record<string, unknown>[],
  options: MarkOptions = {},
): Mark {
  return { type: "text", data, options };
}

// ─── Plot function ───────────────────────────────────────────────────

/**
 * Render a chart composed of one or more marks.
 *
 * @example
 * ```ts
 * import { plot, barY, line } from "@anteros/plot";
 *
 * plot({
 *   driver: "echarts",
 *   target: document.getElementById("chart")!,
 *   title: "Sales & Profit",
 *   marks: [
 *     barY(salesData, { x: "product", y: "sales" }),
 *     line(salesData, { x: "product", y: "profit", smooth: true }),
 *   ],
 * });
 * ```
 */
export function plot(options: PlotOptions): unknown {
  const { driver = "echarts", target, marks, theme, title, width, height, legend, color, x, y, ...rest } = options;

  const driverInstance =
    driver === "echarts"
      ? new EChartsDriver(options)
      : new ObservableDriver(options);

  return driverInstance.render(marks, { theme, title, width, height, legend, color, x, y, ...rest });
}

// ─── Namespace export (for Observable-like `Plot.plot()`) ────────────

export const Plot = { plot, barX, barY, line, pie, scatter, dot, image, tree, network, heatmap, text } as const;

// ─── Types ───────────────────────────────────────────────────────────

export type { Mark, MarkOptions, PlotOptions, AxisConfig, DriverType };
