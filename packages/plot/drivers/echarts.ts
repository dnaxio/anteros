import type { PlotDriver, DriverRenderOptions } from "./types";
import type { Mark, PlotOptions, AxisConfig } from "../types";
import * as echarts from "echarts";
import "@fontsource/mona-sans/600.css";

export class EChartsDriver implements PlotDriver {
  #chart?: echarts.ECharts;
  #target: HTMLElement;
  #theme: "dark" | "default";
  #resizeHandler?: () => void;

  constructor(options: PlotOptions) {
    this.#target = options.target;
    this.#theme = options.theme ?? "default";
  }

  render(marks: Mark[], opts: DriverRenderOptions): echarts.ECharts {
    this.dispose();

    const width = opts.width ?? "100%";
    const height = opts.height ?? "400px";

    this.#target.innerHTML = "";

    const div = document.createElement("div");
    div.style.width = width;
    div.style.height = height;
    this.#target.appendChild(div);

    const chart = echarts.init(div, this.#theme);

    this.#resizeHandler = () => chart.resize();
    window.addEventListener("resize", this.#resizeHandler);

    const option = this.#buildOption(marks, opts);
    chart.setOption(option);
    this.#chart = chart;
    return chart;
  }

  dispose(): void {
    if (this.#resizeHandler) {
      window.removeEventListener("resize", this.#resizeHandler);
      this.#resizeHandler = undefined;
    }
    if (this.#chart) {
      this.#chart.dispose();
      this.#chart = undefined;
    }
  }

  getInstance(): echarts.ECharts | undefined {
    return this.#chart;
  }

  // ─── Build ECharts option from marks ──────────────────────────────

  #buildOption(
    marks: Mark[],
    opts: DriverRenderOptions,
  ): echarts.EChartsOption {
    const datasets: Record<string, unknown>[] = [];
    const series: Record<string, unknown>[] = [];

    let hasCartesian = false;
    let hasPie = false;
    let swapAxes = false;

    for (let i = 0; i < marks.length; i++) {
      const mark = marks[i]!;

      // ── Pie ──────────────────────────────────────────────────────
      if (mark.type === "pie") {
        hasPie = true;
        const s: Record<string, unknown> = {
          type: "pie",
          name: mark.options.name ?? mark.options.x ?? "pie",
          data: mark.data.map((d: any) => ({
            name: d[mark.options.x ?? "name"],
            value: d[mark.options.y ?? "value"],
          })),
          silent: mark.options.tip === false ? true : undefined,
        };
        if (mark.options.fill && !isDataField(mark.options.fill)) {
          s.itemStyle = { color: mark.options.fill };
        }
        series.push(s);
        continue;
      }

      // ── Tree ─────────────────────────────────────────────────────
      if (mark.type === "tree") {
        const s: Record<string, unknown> = {
          type: "tree",
          name: mark.options.name ?? "tree",
          data: mark.data,
          orient: (mark.options as any).orient ?? "LR",
          symbolSize: (mark.options as any).symbolSize ?? 8,
          label: { position: "right" },
        };
        if (mark.options.fill && !isDataField(mark.options.fill)) {
          s.itemStyle = { color: mark.options.fill };
        }
        series.push(s);
        continue;
      }

      // ── Network ──────────────────────────────────────────────────
      if (mark.type === "network") {
        const links = (mark.options.links ?? []) as any[];
        series.push({
          type: "graph",
          name: mark.options.name ?? "network",
          layout: (mark.options as any).layout ?? "force",
          data: mark.data.map((d: any) => ({ name: d.name ?? d.id, ...d })),
          links: links.map((l: any) => ({
            source: l.source ?? l.from,
            target: l.target ?? l.to,
            value: l.value,
          })),
          roam: true,
          label: { show: true, position: "right" },
          force: { repulsion: 200, edgeLength: 100 },
        });
        continue;
      }

      // ── Heatmap ──────────────────────────────────────────────────
      if (mark.type === "heatmap") {
        hasCartesian = true;
        const valField = mark.options.value ?? mark.options.y ?? "value";
        const heatData = mark.data.map((d: any) => [d[mark.options.x!], d[mark.options.y!], d[valField]]);
        const xs = [...new Set(mark.data.map((d: any) => d[mark.options.x!]))];
        const ys = [...new Set(mark.data.map((d: any) => d[mark.options.y!]))];
        series.push({
          type: "heatmap",
          name: mark.options.name ?? "heatmap",
          data: heatData,
          label: { show: true },
        });
        // Store axis data for later use
        (series as any)._heatmapX = xs;
        (series as any)._heatmapY = ys;
        (series as any)._heatmapScheme = mark.options.colorScheme;
        continue;
      }

      // ── Text ────────────────────────────────────────────────────
      if (mark.type === "text") {
        hasCartesian = true;
        const textField = mark.options.text ?? mark.options.y ?? "text";
        const textData = mark.data.map((d: any) => ({
          value: [d[mark.options.x!], d[mark.options.y!]],
          labelText: String(d[textField] ?? ""),
        }));
        series.push({
          type: "scatter",
          name: mark.options.name ?? "text",
          data: textData,
          symbolSize: 0,
          label: {
            show: true,
            formatter: (p: any) => p.data.labelText,
            position: "top",
            offset: [mark.options.dx ?? 0, mark.options.dy ?? 0],
            fontSize: mark.options.fontSize ?? 12,
            color: mark.options.fill ?? "#333",
            fontWeight: (mark.options.fontWeight ?? "normal") as any,
            fontStyle: (mark.options.fontStyle ?? "normal") as any,
            fontFamily: mark.options.fontFamily,
            align: mark.options.textAnchor === "end" ? "right"
              : mark.options.textAnchor === "middle" ? "center"
              : "left",
            verticalAlign: mark.options.lineAnchor === "top" ? "top"
              : mark.options.lineAnchor === "bottom" ? "bottom"
              : "middle",
          },
        });
        continue;
      }

      // ── Image ────────────────────────────────────────────────────
      if (mark.type === "image") {
        hasCartesian = true;
        const srcField = mark.options.src ?? "src";
        const imgData = mark.data.map((d: any) => ({
          value: [d[mark.options.x!], d[mark.options.y!]],
          symbol: `image://${d[srcField]}`,
          symbolSize: [mark.options.width ?? 40, mark.options.height ?? 40],
          itemStyle: mark.options.r != null ? { borderRadius: mark.options.r } : undefined,
        }));
        series.push({
          type: "scatter",
          name: mark.options.name ?? "image",
          data: imgData,
          symbolSize: [mark.options.width ?? 40, mark.options.height ?? 40],
          silent: mark.options.tip === false ? true : undefined,
        });
        continue;
      }

      // ── Cartesian marks (barX, barY, line, scatter, dot) ─────────
      hasCartesian = true;
      if (!swapAxes && datasets.length === 0 && mark.type === "barX") {
        swapAxes = true;
      }
      datasets.push({ source: mark.data });
      const s: Record<string, unknown> = {
        type:
          mark.type === "barX" || mark.type === "barY" ? "bar"
          : mark.type === "dot" ? "scatter"
          : mark.type,
        name: mark.options.name ?? mark.options.y ?? mark.options.x ?? mark.type,
        datasetIndex: datasets.length - 1,
        encode: { x: mark.options.x, y: mark.options.y },
        silent: mark.options.tip === false ? true : undefined,
      };
      if (mark.options.fill && !isDataField(mark.options.fill)) {
        s.itemStyle = { color: mark.options.fill };
      }
      if (mark.options.stroke && !isDataField(mark.options.stroke)) {
        s.lineStyle = { color: mark.options.stroke };
        s.itemStyle = { ...(s.itemStyle as any), borderColor: mark.options.stroke };
      }
      if (mark.type === "line") {
        s.smooth = mark.options.smooth ?? false;
        s.showSymbol = mark.options.showSymbol ?? false;
      }
      if (mark.type === "barX" || mark.type === "barY") {
        s.showBackground = mark.options.showBackground ?? false;
      }
      if (mark.options.r != null) {
        s.itemStyle = { ...(s.itemStyle as any), borderRadius: mark.options.r };
      }
      // Data-driven stroke/fill for scatter/dot
      if ((mark.type === "scatter" || mark.type === "dot") && mark.options.stroke && isDataField(mark.options.stroke)) {
        const strokeField = mark.options.stroke;
        const colorData = mark.data.map((d: any) => ({
          value: [d[mark.options.x!], d[mark.options.y!]],
          itemStyle: { color: String(d[strokeField] ?? "#333") },
        }));
        s.data = colorData;
        delete s.datasetIndex;
        delete (s as any).encode;
      } else if ((mark.type === "scatter" || mark.type === "dot") && mark.options.fill && isDataField(mark.options.fill)) {
        const fillField = mark.options.fill;
        const colorData = mark.data.map((d: any) => ({
          value: [d[mark.options.x!], d[mark.options.y!]],
          itemStyle: { color: String(d[fillField] ?? "#5470c6") },
        }));
        s.data = colorData;
        delete s.datasetIndex;
        delete (s as any).encode;
      }
      series.push(s);
    }

    const option: Record<string, unknown> = {
      animation: true,
      textStyle: { fontFamily: "Mona Sans, sans-serif" },
      tooltip: {
        trigger: hasPie && !hasCartesian ? "item" : "axis",
        backgroundColor: "rgba(255, 255, 255, 0.7)",
        textStyle: { color: "#333" },
        borderColor: "rgba(0, 0, 0, 0.1)",
        borderWidth: 1,
        extraCssText: `
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          border-radius: 3px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
          padding: 8px 12px;
        `,
      },
      series,
    };

    if (datasets.length > 0) {
      option.dataset = datasets;
    }
    if (hasCartesian) {
      const hasHeatmap = marks.some((m) => m.type === "heatmap");
      if (hasHeatmap) {
        // Heatmap: both axes are category
        const xs = [...new Set(marks.flatMap((m) => m.type === "heatmap" ? m.data.map((d: any) => d[m.options.x!]) : []))];
        const ys = [...new Set(marks.flatMap((m) => m.type === "heatmap" ? m.data.map((d: any) => d[m.options.y!]) : []))];
        option.xAxis = { type: "category", data: xs };
        option.yAxis = { type: "category", data: ys };
        // Visual map for color scale
        const hmMark = marks.find((m) => m.type === "heatmap")!;
        option.visualMap = {
          min: 0,
          max: 10,
          calculable: true,
          orient: "horizontal",
          left: "center",
          bottom: 0,
        };
        if (hmMark.options.colorScheme) {
          (option.visualMap as any).inRange = { color: ["#313695", "#4575b4", "#74add1", "#abd9e9", "#fee090", "#fdae61", "#f46d43", "#d73027", "#a50026"] };
        }
      } else {
        option.xAxis = { type: swapAxes ? "value" : "category" };
        option.yAxis = { type: swapAxes ? "category" : "value" };
      }
      applyAxis(option.xAxis as Record<string, unknown>, opts.x);
      applyAxis(option.yAxis as Record<string, unknown>, opts.y);
    }
    if (opts.title) {
      option.title = { text: opts.title, left: "center" };
    }
    if (opts.legend) {
      option.legend = { show: true, top: "bottom" };
    }
    // Global color palette
    if (opts.color) {
      if (Array.isArray(opts.color)) {
        option.color = opts.color;
      } else if (typeof opts.color === "object" && (opts.color as any).scheme) {
        // Pass scheme name — ECharts doesn't have named schemes, use as single color
        option.color = [(opts.color as any).scheme];
      }
    }

    return cleanDeep(option) as echarts.EChartsOption;
  }
}

// ─── Axis helper ──────────────────────────────────────────────────────

function applyAxis(
  echartsAxis: Record<string, unknown>,
  config?: AxisConfig,
): void {
  if (!config) return;
  if (config.label) echartsAxis.name = config.label;
  if (config.grid) echartsAxis.splitLine = { show: true };
  if (config.domain) {
    echartsAxis.min = config.domain[0];
    echartsAxis.max = config.domain[1];
  }
  if (config.tickRotate != null) {
    echartsAxis.axisLabel = {
      ...((echartsAxis.axisLabel ?? {}) as Record<string, unknown>),
      rotate: config.tickRotate,
    };
  }
  if (config.nice) echartsAxis.scale = true;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Check if a string looks like a data field (not a CSS color) */
const CSS_COLORS = new Set([
  "transparent", "currentColor", "inherit", "initial", "unset",
  "none", "black", "white", "red", "green", "blue", "yellow", "cyan",
  "magenta", "gray", "grey", "orange", "purple", "pink", "brown",
  "lime", "navy", "teal", "aqua", "maroon", "olive", "silver",
]);

function isDataField(value: string): boolean {
  if (value.startsWith("#") || value.startsWith("rgb") || value.startsWith("hsl")) {
    return false;
  }
  return !CSS_COLORS.has(value.toLowerCase());
}

function cleanDeep<T>(obj: T): T {
  if (Array.isArray(obj)) {
    const cleaned = obj
      .map((item) => cleanDeep(item))
      .filter((item) => !isEmpty(item));
    return cleaned as T;
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const cleaned = cleanDeep(value);
      if (!isEmpty(cleaned)) {
        result[key] = cleaned;
      }
    }
    return result as T;
  }
  return obj;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "number" && Number.isNaN(value)) return true;
  if (typeof value === "string" && value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as object).length === 0
  )
    return true;
  return false;
}
