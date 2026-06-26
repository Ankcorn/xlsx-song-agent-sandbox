import { defineCatalog, type Spec } from "@json-render/core";
import { JSONUIProvider, Renderer, defineRegistry } from "@json-render/react";
import { schema } from "@json-render/react/schema";
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import { shadcnComponents } from "@json-render/shadcn";
import type React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Cell,
  ComposedChart as RechartsComposedChart,
  Legend,
  Line,
  LineChart as RechartsLineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { z } from "zod";

const tableRowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
const chartValueSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
const seriesSchema = z.object({
  key: z.string(),
  label: z.string().nullable(),
  color: z.string().nullable(),
});
const axisChartSchema = z.object({
  data: z.array(chartValueSchema),
  title: z.string().nullable(),
  description: z.string().nullable(),
  xKey: z.string(),
  series: z.array(seriesSchema).min(1),
  yLabel: z.string().nullable(),
  height: z.number().nullable(),
});
const pieChartSchema = z.object({
  data: z.array(z.object({ label: z.string(), value: z.number(), color: z.string().nullable() })),
  title: z.string().nullable(),
  description: z.string().nullable(),
  valueLabel: z.string().nullable(),
  donut: z.boolean().nullable(),
  height: z.number().nullable(),
});
const scatterChartSchema = z.object({
  data: z.array(chartValueSchema),
  title: z.string().nullable(),
  description: z.string().nullable(),
  xKey: z.string(),
  yKey: z.string(),
  nameKey: z.string().nullable(),
  color: z.string().nullable(),
  height: z.number().nullable(),
});
const composedChartSchema = z.object({
  data: z.array(chartValueSchema),
  title: z.string().nullable(),
  description: z.string().nullable(),
  xKey: z.string(),
  bars: z.array(seriesSchema),
  lines: z.array(seriesSchema),
  areas: z.array(seriesSchema),
  height: z.number().nullable(),
});

const chartColors = ["#18181b", "#0f766e", "#2563eb", "#b45309", "#be123c", "#7c3aed", "#15803d", "#52525b"];

function chartColor(index: number, explicit?: string | null) {
  return explicit || chartColors[index % chartColors.length];
}

function chartHeight(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 280;
  return Math.max(180, Math.min(520, value));
}

function axisTickFormatter(value: unknown) {
  if (typeof value === "number") return value.toLocaleString();
  return String(value ?? "");
}

function tooltipFormatter(value: unknown, name: unknown) {
  const formatted = typeof value === "number" ? value.toLocaleString() : String(value ?? "");
  return [formatted, String(name ?? "")];
}

function ChartShell({ children, description, height, title }: { children: React.ReactNode; description?: string | null; height?: number | null; title?: string | null }) {
  return (
    <div className="llm-chart">
      {title || description ? (
        <div className="llm-chart-header">
          {title ? <h3>{title}</h3> : null}
          {description ? <p>{description}</p> : null}
        </div>
      ) : null}
      <div className="llm-chart-frame" style={{ height: chartHeight(height) }}>
        {children}
      </div>
    </div>
  );
}

export const agentReportCatalog = defineCatalog(schema, {
  actions: {},
  components: {
    Stack: shadcnComponentDefinitions.Stack,
    Grid: shadcnComponentDefinitions.Grid,
    Card: shadcnComponentDefinitions.Card,
    Heading: shadcnComponentDefinitions.Heading,
    Text: shadcnComponentDefinitions.Text,
    Badge: shadcnComponentDefinitions.Badge,
    Alert: shadcnComponentDefinitions.Alert,
    Separator: shadcnComponentDefinitions.Separator,
    Table: shadcnComponentDefinitions.Table,
    StatGrid: {
      description: "A responsive grid of key metrics, counts, totals, scores, or short KPIs.",
      props: z.object({
        items: z.array(
          z.object({
            delta: z.string().nullable(),
            label: z.string(),
            value: z.string(),
            description: z.string().nullable(),
          }),
        ),
      }),
    },
    BarChart: {
      description: "A simple horizontal bar chart for comparing labeled numeric values.",
      props: z.object({
        data: z.array(z.object({ label: z.string(), value: z.number() })),
        title: z.string().nullable(),
        valueLabel: z.string().nullable(),
      }),
    },
    LineChart: {
      description: "A Recharts line chart for time series, trends, and multiple numeric series over a shared x-axis.",
      props: axisChartSchema,
    },
    AreaChart: {
      description: "A Recharts area chart for cumulative values, volume over time, or shaded trends.",
      props: axisChartSchema,
    },
    VerticalBarChart: {
      description: "A Recharts vertical or grouped bar chart for category comparisons with one or more numeric series.",
      props: axisChartSchema,
    },
    PieChart: {
      description: "A Recharts pie or donut chart for part-to-whole breakdowns with a small number of categories.",
      props: pieChartSchema,
    },
    ScatterChart: {
      description: "A Recharts scatter chart for showing relationships between two numeric measures.",
      props: scatterChartSchema,
    },
    ComposedChart: {
      description: "A Recharts composed chart that can combine bars, lines, and areas over one x-axis.",
      props: composedChartSchema,
    },
    KeyValueList: {
      description: "A compact two-column list for metadata, assumptions, and source details.",
      props: z.object({
        items: z.array(z.object({ label: z.string(), value: z.string() })),
        title: z.string().nullable(),
      }),
    },
    DataTable: {
      description: "A shadcn-styled data table for small structured result sets.",
      props: z.object({
        caption: z.string().nullable(),
        columns: z.array(z.string()),
        rows: z.array(tableRowSchema),
      }),
    },
  },
});

const { registry } = defineRegistry(agentReportCatalog, {
  components: {
    Stack: shadcnComponents.Stack,
    Grid: shadcnComponents.Grid,
    Card: shadcnComponents.Card,
    Heading: (componentProps) => {
      if (!componentProps.props.text?.trim()) return <></>;
      return shadcnComponents.Heading(componentProps);
    },
    Text: (componentProps) => {
      if (!componentProps.props.text?.trim()) return <></>;
      return shadcnComponents.Text(componentProps);
    },
    Badge: shadcnComponents.Badge,
    Alert: shadcnComponents.Alert,
    Separator: shadcnComponents.Separator,
    Table: shadcnComponents.Table,
    StatGrid: ({ props }) => (
      <div className="llm-stat-grid">
        {props.items.map((item, index) => (
          <div className="llm-stat-card" key={`${item.label}-${index}`}>
            <div className="llm-stat-card-header">
              <span>{item.label}</span>
              {item.delta ? <span className="llm-stat-delta">{item.delta}</span> : null}
            </div>
            <strong>{item.value}</strong>
            {item.description ? <p>{item.description}</p> : null}
          </div>
        ))}
      </div>
    ),
    BarChart: ({ props }) => {
      const max = Math.max(1, ...props.data.map((item) => Math.abs(item.value)));
      return (
        <div className="llm-bar-chart">
          {props.title ? <h3>{props.title}</h3> : null}
          <div className="llm-bar-list">
            {props.data.map((item, index) => (
              <div className="llm-bar-row" key={`${item.label}-${index}`}>
                <div className="llm-bar-meta">
                  <span className="llm-bar-label">{item.label}</span>
                  <span className="llm-bar-value">
                    {item.value.toLocaleString()}
                    {props.valueLabel ? ` ${props.valueLabel}` : ""}
                  </span>
                </div>
                <div className="llm-bar-track">
                  <div className="llm-bar-fill" style={{ width: `${Math.max(4, (Math.abs(item.value) / max) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    },
    LineChart: ({ props }) => (
      <ChartShell description={props.description} height={props.height} title={props.title}>
        <ResponsiveContainer height="100%" width="100%">
          <RechartsLineChart data={props.data} margin={{ bottom: 6, left: 0, right: 12, top: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={props.xKey} tickLine={false} />
            <YAxis tickFormatter={axisTickFormatter} tickLine={false} width={56} />
            <Tooltip formatter={tooltipFormatter} />
            {props.series.length > 1 ? <Legend /> : null}
            {props.series.map((series, index) => (
              <Line
                activeDot={{ r: 5 }}
                dataKey={series.key}
                dot={false}
                key={series.key}
                name={series.label ?? series.key}
                stroke={chartColor(index, series.color)}
                strokeWidth={2.5}
                type="monotone"
              />
            ))}
          </RechartsLineChart>
        </ResponsiveContainer>
      </ChartShell>
    ),
    AreaChart: ({ props }) => (
      <ChartShell description={props.description} height={props.height} title={props.title}>
        <ResponsiveContainer height="100%" width="100%">
          <AreaChart data={props.data} margin={{ bottom: 6, left: 0, right: 12, top: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={props.xKey} tickLine={false} />
            <YAxis tickFormatter={axisTickFormatter} tickLine={false} width={56} />
            <Tooltip formatter={tooltipFormatter} />
            {props.series.length > 1 ? <Legend /> : null}
            {props.series.map((series, index) => (
              <Area
                dataKey={series.key}
                fill={chartColor(index, series.color)}
                fillOpacity={0.16}
                key={series.key}
                name={series.label ?? series.key}
                stroke={chartColor(index, series.color)}
                strokeWidth={2.25}
                type="monotone"
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </ChartShell>
    ),
    VerticalBarChart: ({ props }) => (
      <ChartShell description={props.description} height={props.height} title={props.title}>
        <ResponsiveContainer height="100%" width="100%">
          <RechartsBarChart data={props.data} margin={{ bottom: 6, left: 0, right: 12, top: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={props.xKey} tickLine={false} />
            <YAxis tickFormatter={axisTickFormatter} tickLine={false} width={56} />
            <Tooltip formatter={tooltipFormatter} />
            {props.series.length > 1 ? <Legend /> : null}
            {props.series.map((series, index) => (
              <Bar dataKey={series.key} fill={chartColor(index, series.color)} key={series.key} name={series.label ?? series.key} radius={[6, 6, 0, 0]} />
            ))}
          </RechartsBarChart>
        </ResponsiveContainer>
      </ChartShell>
    ),
    PieChart: ({ props }) => (
      <ChartShell description={props.description} height={props.height} title={props.title}>
        <ResponsiveContainer height="100%" width="100%">
          <PieChart>
            <Tooltip formatter={(value, name) => [`${typeof value === "number" ? value.toLocaleString() : value}${props.valueLabel ? ` ${props.valueLabel}` : ""}`, String(name)]} />
            <Legend />
            <Pie
              cx="50%"
              cy="50%"
              data={props.data}
              dataKey="value"
              innerRadius={props.donut ? 58 : 0}
              nameKey="label"
              outerRadius={92}
              paddingAngle={2}
            >
              {props.data.map((item, index) => (
                <Cell fill={chartColor(index, item.color)} key={`${item.label}-${index}`} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </ChartShell>
    ),
    ScatterChart: ({ props }) => (
      <ChartShell description={props.description} height={props.height} title={props.title}>
        <ResponsiveContainer height="100%" width="100%">
          <ScatterChart data={props.data} margin={{ bottom: 6, left: 0, right: 12, top: 8 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey={props.xKey} name={props.xKey} tickFormatter={axisTickFormatter} tickLine={false} type="number" />
            <YAxis dataKey={props.yKey} name={props.yKey} tickFormatter={axisTickFormatter} tickLine={false} type="number" width={56} />
            <Tooltip cursor={{ strokeDasharray: "3 3" }} formatter={tooltipFormatter} />
            <Scatter dataKey={props.yKey} fill={chartColor(0, props.color)} name={props.nameKey ?? props.yKey} />
          </ScatterChart>
        </ResponsiveContainer>
      </ChartShell>
    ),
    ComposedChart: ({ props }) => (
      <ChartShell description={props.description} height={props.height} title={props.title}>
        <ResponsiveContainer height="100%" width="100%">
          <RechartsComposedChart data={props.data} margin={{ bottom: 6, left: 0, right: 12, top: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={props.xKey} tickLine={false} />
            <YAxis tickFormatter={axisTickFormatter} tickLine={false} width={56} />
            <Tooltip formatter={tooltipFormatter} />
            <Legend />
            {props.areas.map((series, index) => (
              <Area
                dataKey={series.key}
                fill={chartColor(index, series.color)}
                fillOpacity={0.12}
                key={`area-${series.key}`}
                name={series.label ?? series.key}
                stroke={chartColor(index, series.color)}
                type="monotone"
              />
            ))}
            {props.bars.map((series, index) => (
              <Bar dataKey={series.key} fill={chartColor(index + props.areas.length, series.color)} key={`bar-${series.key}`} name={series.label ?? series.key} radius={[6, 6, 0, 0]} />
            ))}
            {props.lines.map((series, index) => (
              <Line
                dataKey={series.key}
                dot={false}
                key={`line-${series.key}`}
                name={series.label ?? series.key}
                stroke={chartColor(index + props.areas.length + props.bars.length, series.color)}
                strokeWidth={2.5}
                type="monotone"
              />
            ))}
          </RechartsComposedChart>
        </ResponsiveContainer>
      </ChartShell>
    ),
    KeyValueList: ({ props }) => (
      <div className="llm-key-value">
        {props.title ? <h3>{props.title}</h3> : null}
        <dl>
          {props.items.map((item, index) => (
            <div key={`${item.label}-${index}`}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    ),
    DataTable: ({ props }) => (
      <div className="llm-data-table">
        <div>
          <table>
            <thead>
              <tr>
                {props.columns.map((column) => (
                  <th key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {props.columns.map((column) => (
                    <td key={column}>
                      {String(row[column] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {props.caption ? <p>{props.caption}</p> : null}
      </div>
    ),
  },
});

export function JsonRenderReport({ spec }: { spec: Spec }) {
  const initialState = typeof spec === "object" && spec && "state" in spec ? (spec as Spec & { state?: Record<string, unknown> }).state : undefined;

  return (
    <JSONUIProvider registry={registry} initialState={initialState}>
      <div className="llm-report">
        <Renderer registry={registry} spec={spec} />
      </div>
    </JSONUIProvider>
  );
}
