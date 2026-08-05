import type { PlotOptionConfig } from "./types";
import * as echarts from "echarts";

class Plot {
  #chart?: echarts.ECharts;
  #target: HTMLDivElement;
  #config: { theme: "dark" | "default" };
  #resizeHandler?: () => void;

  constructor(
    target: HTMLDivElement,
    config: { theme: "dark" | "default" } = { theme: "default" }
  ) {
    this.#target = target;
    this.#config = config;
  }

  /** Access the underlying ECharts instance for advanced usage */
  get chart(): echarts.ECharts | undefined {
    return this.#chart;
  }

  plot(param: PlotOptionConfig): echarts.ECharts {
    const containerRef = param.target || this.#target;
    let container: Element | null;
    if (typeof containerRef === "string") {
      container = document.querySelector(containerRef);
    } else {
      container = containerRef;
    }
    if (!container) {
      throw new Error("Plot: target container not found");
    }

    // Dispose previous chart if any
    this.dispose();

    const div = document.createElement("div");
    div.style.width = param.width;
    div.style.height = param.height;
    container.appendChild(div);

    const chart = echarts.init(div, this.#config.theme);

    // Store resize handler for cleanup
    this.#resizeHandler = () => chart.resize();
    window.addEventListener("resize", this.#resizeHandler);

    const options = buildOption(param);
    chart.setOption(options);
    this.#chart = chart;
    return chart;
  }

  /** Dispose the chart instance and clean up event listeners */
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
}

const Interaction = {
  connect: (instances: Array<echarts.ECharts>) => {
    echarts.connect(instances);
  },
  disconnect: (groupId: string) => {
    echarts.disconnect(groupId);
  },
};

function buildOption(cfg: PlotOptionConfig): echarts.EChartsOption {
  try {
    const merged = {
      animation: cfg.animation ?? true,
      legend: cfg.legend,
      textStyle: { fontFamily: "Mona Sans, sans-serif" },
      tooltip: {
        trigger: "item",
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
        ...cfg.tooltip,
      },
      xAxis: { ...cfg.xAxis },
      yAxis: { ...cfg.yAxis },
      dataset: { ...cfg.dataset },
      visualMap: { ...cfg.visualMap },
      series: [...(cfg.series?.filter((e) => !e.disable) ?? [])],
    };

    return cleanDeep({ ...cleanDeep(cfg), ...merged }) as echarts.EChartsOption;
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : err);
    return {};
  }
}

/** Remove null, undefined, NaN, empty strings/objects/arrays recursively */
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

export { Plot, Interaction };
