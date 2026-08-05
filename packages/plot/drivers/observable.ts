import type { PlotDriver, DriverRenderOptions } from "./types";
import type { Mark, PlotOptions, AxisConfig } from "../types";
import * as Plot from "@observablehq/plot";

export class ObservableDriver implements PlotDriver {
  #target: HTMLElement;
  #element?: Element;
  #resizeObserver?: ResizeObserver;
  #lastRender?: { marks: Mark[]; opts: DriverRenderOptions };

  constructor(options: PlotOptions) {
    this.#target = options.target;
  }

  render(marks: Mark[], opts: DriverRenderOptions): Element | undefined {
    this.dispose();

    // Convert each unified mark → Observable Plot mark(s)
    const plotMarks = marks.flatMap((m) => {
      const result = this.#toObsMark(m);
      return Array.isArray(result) ? result : [result];
    });

    const plotOptions: Record<string, unknown> = { grid: true };

    // Axis config (passed directly to Observable Plot)
    if (opts.x) plotOptions.x = cleanAxis(opts.x);
    if (opts.y) plotOptions.y = cleanAxis(opts.y);

    // Color scheme
    if ((opts as any).color) plotOptions.color = (opts as any).color;

    // Margins
    if ((opts as any).margin) plotOptions.margin = (opts as any).margin;
    if ((opts as any).marginTop) plotOptions.marginTop = (opts as any).marginTop;
    if ((opts as any).marginRight) plotOptions.marginRight = (opts as any).marginRight;
    if ((opts as any).marginBottom) plotOptions.marginBottom = (opts as any).marginBottom;
    if ((opts as any).marginLeft) plotOptions.marginLeft = (opts as any).marginLeft;

    // Legend
    if (opts.legend) {
      plotOptions.color = { ...(plotOptions.color as any), legend: true };
    }

    // Global color config (Observable Plot natively supports color)
    if (opts.color) {
      plotOptions.color = {
        ...(plotOptions.color as any),
        ...(typeof opts.color === "object" && !Array.isArray(opts.color) ? opts.color : { scheme: (opts.color as any).scheme }),
      };
    }

    // Style overrides
    if ((opts as any).style) plotOptions.style = (opts as any).style;
    if ((opts as any).className) plotOptions.className = (opts as any).className;
    if ((opts as any).inset) plotOptions.inset = (opts as any).inset;
    if ((opts as any).facet) plotOptions.facet = (opts as any).facet;

    if (opts.width) {
      const w = parseInt(opts.width);
      if (!Number.isNaN(w)) plotOptions.width = w;
    }
    if (opts.height) {
      const h = parseInt(opts.height);
      if (!Number.isNaN(h)) plotOptions.height = h;
    }

    const plotElement = Plot.plot({ ...plotOptions, marks: plotMarks } as any);

    if (opts.title) {
      const wrapper = document.createElement("div");
      const titleEl = document.createElement("div");
      titleEl.textContent = opts.title;
      titleEl.style.cssText =
        "font-family: system-ui, sans-serif; font-size: 16px; font-weight: 600; text-align: center; margin-bottom: 8px;";
      wrapper.appendChild(titleEl);
      wrapper.appendChild(plotElement);
      this.#target.innerHTML = "";
      this.#target.appendChild(wrapper);
      this.#element = wrapper;
    } else {
      this.#target.innerHTML = "";
      this.#target.appendChild(plotElement);
      this.#element = plotElement;
    }

    // Auto-resize
    this.#lastRender = { marks, opts };
    this.#resizeObserver = new ResizeObserver(() => {
      if (this.#lastRender) {
        this.render(this.#lastRender.marks, this.#lastRender.opts);
      }
    });
    this.#resizeObserver.observe(this.#target);

    return this.#element;
  }

  dispose(): void {
    if (this.#resizeObserver) {
      this.#resizeObserver.disconnect();
      this.#resizeObserver = undefined;
    }
    if (this.#element) {
      this.#element.remove();
      this.#element = undefined;
    }
  }

  getInstance(): unknown {
    return this.#element;
  }

  // ─── Convert unified Mark → Observable Plot mark ──────────────────

  #toObsMark(mark: Mark): any {
    const { type, data, options } = mark;
    const markOpts: Record<string, unknown> = {};

    if (options.x) markOpts.x = options.x;
    if (options.y) markOpts.y = options.y;
    if (options.fill) markOpts.fill = options.fill;
    if (options.stroke) markOpts.stroke = options.stroke;
    if (options.r != null) markOpts.r = options.r;
    if (options.tip != null) markOpts.tip = options.tip;
    if (options.title) markOpts.title = options.title;

    switch (type) {
      case "barX":
        return Plot.barX(data, markOpts);
      case "barY":
        return Plot.barY(data, markOpts);
      case "line": {
        if (options.smooth) markOpts.curve = "catmull-rom";
        if (options.showSymbol) markOpts.marker = "circle";
        return Plot.lineY(data, markOpts);
      }
      case "scatter":
      case "dot":
        return Plot.dot(data, markOpts);
      case "image": {
        if (options.src) markOpts.src = options.src;
        if (options.width) markOpts.width = options.width;
        if (options.height) markOpts.height = options.height;
        if (options.r != null) markOpts.r = options.r;
        return Plot.image(data, markOpts);
      }
      case "tree": {
        const paths = flattenTree(data);
        return Plot.tree(paths, markOpts);
      }
      case "network": {
        const links = (options.links ?? []) as any[];
        const positioned = layoutCircular(data, links);
        return [
          Plot.link(positioned.links, {
            x1: "x1", y1: "y1", x2: "x2", y2: "y2",
            stroke: options.stroke ?? "#999",
            strokeWidth: 1.5,
          }),
          Plot.dot(positioned.nodes, {
            x: "x", y: "y",
            fill: options.fill ?? "#5470c6",
            r: options.r ?? 6,
            title: "name",
          }),
          Plot.text(positioned.nodes, {
            x: "x", y: "y",
            text: "name",
            dy: -12,
            textAnchor: "middle",
            fontSize: 11,
          }),
        ];
      }
      case "heatmap": {
        const valField = options.value ?? options.y ?? "value";
        markOpts.fill = valField;
        if (options.colorScheme) (markOpts as any).color = { scheme: options.colorScheme };
        return Plot.cell(data, markOpts);
      }
      case "text": {
        const textField = options.text ?? options.y ?? "text";
        markOpts.text = textField;
        if (options.dy != null) markOpts.dy = options.dy;
        if (options.dx != null) markOpts.dx = options.dx;
        if (options.textAnchor) markOpts.textAnchor = options.textAnchor;
        if (options.lineAnchor) markOpts.lineAnchor = options.lineAnchor;
        if (options.fontSize) markOpts.fontSize = options.fontSize;
        if (options.fontFamily) markOpts.fontFamily = options.fontFamily;
        if (options.fontWeight != null) markOpts.fontWeight = options.fontWeight;
        if (options.fontStyle) markOpts.fontStyle = options.fontStyle;
        if (options.fill) markOpts.fill = options.fill;
        return Plot.text(data, markOpts);
      }
      case "pie":
        throw new Error(
          "Pie charts are not supported by Observable Plot. Use driver: 'echarts' for pie charts.",
        );
      default:
        throw new Error(`Unknown chart type: ${type}`);
    }
  }
}

/** Convert {name, children} tree → slash-separated paths for Observable Plot */
function flattenTree(
  nodes: Record<string, unknown>[],
  prefix = "",
): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    const name = String(node.name ?? "");
    const path = prefix ? `${prefix}/${name}` : name;
    paths.push(path);
    const children = node.children as Record<string, unknown>[] | undefined;
    if (children && children.length > 0) {
      paths.push(...flattenTree(children, path));
    }
  }
  return paths;
}

/** Compute circular x,y positions for network nodes */
function layoutCircular(
  nodes: Record<string, unknown>[],
  links: any[],
): { nodes: Record<string, unknown>[]; links: Record<string, unknown>[] } {
  const r = Math.min(400, nodes.length * 20);
  const positionedNodes = nodes.map((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    return { ...n, x: r * Math.cos(angle), y: r * Math.sin(angle) } as Record<string, unknown> & { x: number; y: number };
  });
  const nodeMap = new Map(positionedNodes.map((n) => [n.name ?? n.id, n]));
  const positionedLinks = links
    .map((l) => {
      const src = nodeMap.get(l.source ?? l.from);
      const tgt = nodeMap.get(l.target ?? l.to);
      if (!src || !tgt) return null;
      return { ...l, x1: src.x, y1: src.y, x2: tgt.x, y2: tgt.y };
    })
    .filter(Boolean) as Record<string, unknown>[];
  return { nodes: positionedNodes, links: positionedLinks };
}

/** Strip undefined values from axis config (Observable Plot ignores them) */
function cleanAxis(config: AxisConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (config.label) out.label = config.label;
  if (config.grid != null) out.grid = config.grid;
  if (config.domain) out.domain = config.domain;
  if (config.tickRotate != null) out.tickRotate = config.tickRotate;
  if (config.type) out.type = config.type;
  if (config.nice != null) out.nice = config.nice;
  if (config.zero != null) out.zero = config.zero;
  if (config.tickFormat) out.tickFormat = config.tickFormat;
  return out;
}
