import type { Mark, AxisConfig } from "../types";

/** Options forwarded to the driver (everything except driver/target/marks) */
export interface DriverRenderOptions {
  theme?: "dark" | "default";
  title?: string;
  width?: string;
  height?: string;
  legend?: boolean;
  color?: string[] | { scheme?: string; type?: string; legend?: boolean; domain?: unknown[]; range?: string[] };
  x?: AxisConfig;
  y?: AxisConfig;
  [key: string]: unknown;
}

/** Interface that every rendering driver must implement */
export interface PlotDriver {
  /** Render an array of marks on the same chart. Returns the native instance or DOM element. */
  render(marks: Mark[], options: DriverRenderOptions): unknown;
  /** Clean up resources (event listeners, DOM, native instances) */
  dispose(): void;
  /** Access the underlying native chart instance or DOM element */
  getInstance(): unknown;
}
