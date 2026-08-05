# @anteros/plot

A lightweight, declarative charting library with a **mark-based unified API** across rendering engines — inspired by [Observable Plot](https://observablehq.com/plot/). Powered by [Apache ECharts](https://echarts.apache.org/) and [Observable Plot](https://observablehq.com/plot/).

## Features

- **11 mark types** — `barX`, `barY`, `line`, `pie`, `scatter`, `dot`, `image`, `tree`, `network`, `heatmap`, `text`
- **Multi-mark composition** — Layer as many marks as you want on the same chart
- **Multi-driver** — `echarts` (default) or `observable`. Same API, swap the driver
- **Axis config** — `label`, `grid`, `domain`, `tickRotate`, `type`, `nice`, `zero`
- **Auto-color + Legend** — Each driver auto-assigns colors; `legend: true` to display
- **Responsive** — Auto-resize with proper cleanup (`dispose()`)
- **TypeScript First** — Full type definitions

---

## Installation

```bash
bun install
```

---

## Quick Start

```typescript
import { plot, barY } from "@anteros/plot";

plot({
  target: document.getElementById("chart")!,
  title: "Sales by Product",
  marks: [
    barY(
      [
        { product: "Laptop", sales: 120 },
        { product: "Phone",  sales: 200 },
        { product: "Tablet", sales: 90 },
      ],
      { x: "product", y: "sales" },
    ),
  ],
});
```

> `driver` defaults to `"echarts"`. Use `driver: "observable"` to switch.

### Namespace usage

```typescript
import { Plot } from "@anteros/plot";

Plot.plot({
  target: container,
  marks: [Plot.barY(data, { x: "product", y: "sales" })],
});
```

---

## API Reference

### Mark factories

```typescript
barX(data, options): Mark    // horizontal bars
barY(data, options): Mark    // vertical bars
line(data, options): Mark    // line chart
pie(data, options): Mark     // pie chart (ECharts only)
scatter(data, options): Mark // scatter plot
dot(data, options): Mark     // alias for scatter (Observable naming)
image(data, options): Mark   // images at data positions
tree(data, options): Mark    // hierarchy {name, children}
network(data, options): Mark // graph (nodes + edges)
heatmap(data, options): Mark // heatmap (x × y grid)
text(data, options): Mark    // text labels
```

### Common Mark options

| Option | Type | Marks | Description |
|--------|------|-------|-------------|
| `x` | `string` | all† | X-axis / category / name field |
| `y` | `string` | all† | Y-axis / value field |
| `fill` | `string` | all | Interior color. Auto if unset |
| `stroke` | `string` | all | Outline / line color. Auto if unset |
| `r` | `number` | bar, image | Border radius (px) |
| `name` | `string` | all | Legend/series name |
| `tip` | `boolean` | all | Enable tooltip (default: true) |
| `title` | `string` | all | Tooltip text field — shows this column on hover |

† `tree`/`network` use their own data format (see below).

### Mark-specific options

| Option | Marks | Description |
|--------|-------|-------------|
| `smooth` | line | Smooth curve interpolation |
| `showSymbol` | line | Show point markers |
| `showBackground` | barX/barY | Background grid |
| `src` | image | Image URL field |
| `width` | image | Image width (px) |
| `height` | image | Image height (px) |
| `links` | network | `[{source, target}]` edges |
| `value` | heatmap | Intensity field for color |
| `colorScheme` | heatmap | Palette name (`"warm"`, `"viridis"`…) |
| `text` | text | Text field to display |
| `dx` | text | Horizontal offset (px) |
| `dy` | text | Vertical offset (px) |
| `textAnchor` | text | `"start"`, `"middle"`, `"end"` |
| `lineAnchor` | text | `"top"`, `"bottom"`, `"middle"` |
| `fontSize` | text | Font size (px) |
| `fontFamily` | text | Font family |
| `fontWeight` | text | `"normal"`, `"bold"`, `600`… |
| `fontStyle` | text | `"normal"`, `"italic"` |

> **Data-driven colors:** `fill`/`stroke` can be a CSS color (`"#e74c3c"`, `"red"`) for a constant, or a field name (`"temperature"`, `"category"`) to map colors from data values.

### `plot(options)`

```typescript
interface PlotOptions {
  driver?: "echarts" | "observable";  // default: "echarts"
  target: HTMLElement;
  marks: Mark[];
  theme?: "dark" | "default";         // ECharts only
  title?: string;
  width?: string;
  height?: string;
  legend?: boolean;                    // Show legend
  color?: string[] | {                 // Global color scale
    scheme?: string;                   // Palette name (Observable: "turbo", "warm"…)
    type?: string;                     // "categorical", "linear"… (Observable)
    legend?: boolean;                  // Show color legend (Observable)
  };
  x?: AxisConfig;
  y?: AxisConfig;
}

interface AxisConfig {
  label?: string;
  grid?: boolean;
  domain?: [number, number];
  tickRotate?: number;
  type?: "linear" | "log" | "band";
  nice?: boolean;
  zero?: boolean;
  tickFormat?: string;
}
```

---

## Examples

### Bar + Line + Text on same chart

```typescript
import { plot, barY, line, text } from "@anteros/plot";

const data = [
  { month: "Jan", sales: 120, profit: 40 },
  { month: "Feb", sales: 200, profit: 80 },
  { month: "Mar", sales: 90,  profit: 30 },
];

plot({
  target: container,
  title: "Sales & Profit",
  marks: [
    barY(data, { x: "month", y: "sales", name: "Sales", fill: "#5470c6" }),
    line(data, { x: "month", y: "profit", name: "Profit", stroke: "#91cc75", smooth: true }),
    text(data, { x: "month", y: "sales", text: "sales", dy: -10, textAnchor: "middle", fontSize: 12 }),
  ],
});
```

### Legend

```typescript
plot({
  target: container,
  legend: true,
  marks: [
    barY(data, { x: "month", y: "sales", name: "Sales", fill: "#5470c6" }),
    line(data, { x: "month", y: "profit", name: "Profit", stroke: "#91cc75" }),
  ],
});
```

### Data-driven colors

```typescript
// "Anomaly" n'est pas une couleur → traité comme un champ de données
plot({
  target: container,
  color: { scheme: "rdbu", legend: true },
  marks: [
    dot(data, { x: "Date", y: "Anomaly", fill: "Anomaly" }),
  ],
});
```

### Tooltip control

```typescript
plot({
  target: container,
  marks: [
    barY(data, { x: "month", y: "sales", tip: false }),      // sans tooltip
    line(data, { x: "month", y: "profit", title: "profit" }), // tooltip custom
  ],
});
```

### Global color palette

```typescript
plot({
  target: container,
  color: ["#e74c3c", "#2ecc71", "#3498db"],
  legend: true,
  marks: [
    barY(data, { x: "month", y: "sales", name: "Sales" }),
    line(data, { x: "month", y: "profit", name: "Profit" }),
  ],
});
```

### Line with smooth curves and symbols

```typescript
plot({
  target: container,
  marks: [
    line(data, { x: "month", y: "revenue", smooth: true, showSymbol: true }),
  ],
});
```

### Pie chart

```typescript
plot({
  target: container,
  marks: [pie(data, { x: "browser", y: "share" })],
});
```

> Observable Plot does not support pie. Use `driver: "echarts"` (default).

### Scatter / Dot

```typescript
plot({
  target: container,
  marks: [dot(data, { x: "height", y: "weight", fill: "#e74c3c", r: 4 })],
});
```

### Image mark

```typescript
const flags = [
  { country: "France",  x: 2,  y: 48, src: "https://flagcdn.com/fr.svg" },
  { country: "Germany", x: 10, y: 51, src: "https://flagcdn.com/de.svg" },
];

plot({
  target: container,
  x: { label: "Longitude" },
  y: { label: "Latitude" },
  marks: [
    image(flags, { x: "x", y: "y", src: "src", width: 30, height: 20, r: 4 }),
  ],
});
```

### Tree (hierarchy)

```typescript
const orgChart = [
  {
    name: "CEO",
    children: [
      { name: "CTO", children: [{ name: "Dev A" }, { name: "Dev B" }] },
      { name: "CFO", children: [{ name: "Accountant" }] },
    ],
  },
];

plot({
  target: container,
  marks: [tree(orgChart, { fill: "#5470c6" })],
});
```

### Network (graph)

```typescript
const nodes = [
  { name: "Alice" }, { name: "Bob" }, { name: "Charlie" },
];
const links = [
  { source: "Alice", target: "Bob" },
  { source: "Bob", target: "Charlie" },
];

plot({
  target: container,
  marks: [network(nodes, { links, fill: "#5470c6", stroke: "#999" })],
});
```

### Heatmap

```typescript
const temps = [
  { day: "Mon", hour: "08h", value: 12 },
  { day: "Mon", hour: "12h", value: 22 },
  { day: "Tue", hour: "08h", value: 10 },
  { day: "Tue", hour: "12h", value: 24 },
];

plot({
  target: container,
  x: { label: "Day" },
  y: { label: "Hour" },
  marks: [heatmap(temps, { x: "day", y: "hour", value: "value", colorScheme: "warm" })],
});
```

### Dark theme + axis config

```typescript
plot({
  target: container,
  theme: "dark",
  x: { label: "Month", grid: true, tickRotate: 45 },
  y: { label: "Revenue ($)", grid: true, domain: [0, 1000] },
  marks: [barY(data, { x: "month", y: "revenue" })],
});
```

### Observable Plot driver

```typescript
plot({
  driver: "observable",
  target: container,
  marks: [
    barY(data, { x: "product", y: "sales" }),
    line(data, { x: "product", y: "profit", smooth: true }),
  ],
});
```

### Driver compatibility

| Mark | ECharts | Observable |
|------|---------|------------|
| `barX` / `barY` | ✅ | ✅ |
| `line` | ✅ | ✅ |
| `pie` | ✅ | ❌ |
| `scatter` / `dot` | ✅ | ✅ |
| `image` | ✅ | ✅ |
| `tree` | ✅ | ✅ |
| `network` | ✅ | ✅ (circular layout) |
| `heatmap` | ✅ | ✅ |
| `text` | ✅ | ✅ |

---

## Advanced: Direct Provider Access

```typescript
// Raw ECharts
import { Plot, Interaction } from "@anteros/plot/echarts";

const p = new Plot(container, { theme: "dark" });
p.plot({ /* full ECharts PlotOptionConfig */ });

// Raw Observable Plot
import { Plot } from "@anteros/plot/observable";
```

---

## Package Structure

```
packages/plot/
├── index.ts                 # Mark factories + plot() + Plot namespace
├── types.ts                 # Mark, MarkOptions, PlotOptions, AxisConfig
├── drivers/
│   ├── types.ts             # PlotDriver interface
│   ├── echarts.ts           # EChartsDriver
│   └── observable.ts        # ObservableDriver
├── echarts/                 # Raw ECharts provider (advanced)
│   ├── index.ts
│   ├── Plot.ts
│   └── types.ts
├── observable/              # Raw Observable Plot provider
│   └── index.ts
├── package.json
├── tsconfig.json
└── README.md
```

### Entry Points

| Import | Description | Status |
|--------|-------------|--------|
| `@anteros/plot` | Mark-based unified API | ✅ Ready |
| `@anteros/plot/echarts` | Raw ECharts provider | ✅ Ready |
| `@anteros/plot/observable` | Raw Observable Plot provider | ✅ Ready |

---

## Dependencies

| Dependency | Purpose |
|------------|---------|
| `echarts` | Apache ECharts engine |
| `@observablehq/plot` | Observable Plot engine |
| `@fontsource/mona-sans` | Default font (ECharts only) |

---

## License

MIT — Part of the Anteros project.
