// @anteros/plot/observable — Raw Observable Plot provider
//
// Usage:
//   import { Plot } from "@anteros/plot/observable";
//   Plot.plot({ marks: [Plot.barY(data, {x, y})] });
//
// Or use the driver directly:
//   import { ObservableDriver } from "@anteros/plot/observable";

export * as Plot from "@observablehq/plot";
export { ObservableDriver } from "../drivers/observable";
