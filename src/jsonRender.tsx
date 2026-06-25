import { defineCatalog, type Spec } from "@json-render/core";
import { JSONUIProvider, Renderer, defineRegistry } from "@json-render/react";
import { schema } from "@json-render/react/schema";
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import { shadcnComponents } from "@json-render/shadcn";
import { z } from "zod";

const tableRowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

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
    Heading: shadcnComponents.Heading,
    Text: shadcnComponents.Text,
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
