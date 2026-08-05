import type { EChartsOption, SeriesOption } from "echarts";

export type Serie = SeriesOption & {
  disable: boolean;
  type: "bar" | "line" | "pie" | "scatter" | "heatmap";
  colorBy: "series" | "data";
  showBackground: boolean;
  name: string;
  encode: {
    x: string;
    y: string;
  };
  showSymbol: boolean;
  symbol:
    | "circle"
    | "rect"
    | "roundRect"
    | "triangle"
    | "diamond"
    | "pin"
    | `image://${string}`;
  smooth: boolean;
  label: {
    show: boolean;
    position: "top" | "bottom" | "center";
    formatter: string;
  };
};

export type PlotOptionConfig = {
  animation: boolean;
  height: string;
  width: string;
  target: string | HTMLDivElement;
  tooltip: EChartsOption["tooltip"];
  dataset: {
    source: Array<object>;
    dimensions: Array<string>;
  };
  legend: {
    orient: "vertical" | "horizontal";
    data: Array<string>;
  };
  xAxis: EChartsOption["xAxis"] & {
    name: string;
    type: "value" | "category" | "time";
  };
  yAxis: EChartsOption["yAxis"] & {
    name: string;
    type: "value" | "category" | "time";
  };
  series: Serie[];
} & EChartsOption;
