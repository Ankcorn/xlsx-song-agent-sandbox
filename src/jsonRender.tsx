import { defineCatalog, type Spec } from "@json-render/core";
import { defineRegistry, Renderer } from "@json-render/react";
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
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {props.items.map((item, index) => (
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm" key={`${item.label}-${index}`}>
            <div className="flex items-start justify-between gap-3">
              <span className="text-sm font-medium text-zinc-500">{item.label}</span>
              {item.delta ? <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">{item.delta}</span> : null}
            </div>
            <strong className="mt-2 block text-2xl font-semibold leading-none text-zinc-950">{item.value}</strong>
            {item.description ? <p className="mt-2 text-sm leading-relaxed text-zinc-500">{item.description}</p> : null}
          </div>
        ))}
      </div>
    ),
    BarChart: ({ props }) => {
      const max = Math.max(1, ...props.data.map((item) => Math.abs(item.value)));
      return (
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          {props.title ? <h3 className="mb-4 text-base font-semibold text-zinc-950">{props.title}</h3> : null}
          <div className="grid gap-3">
            {props.data.map((item, index) => (
              <div className="grid gap-1.5" key={`${item.label}-${index}`}>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate font-medium text-zinc-700">{item.label}</span>
                  <span className="font-mono text-xs text-zinc-500">
                    {item.value.toLocaleString()}
                    {props.valueLabel ? ` ${props.valueLabel}` : ""}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-zinc-100">
                  <div className="h-full rounded-full bg-zinc-900" style={{ width: `${Math.max(4, (Math.abs(item.value) / max) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    },
    KeyValueList: ({ props }) => (
      <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        {props.title ? <h3 className="mb-3 text-base font-semibold text-zinc-950">{props.title}</h3> : null}
        <dl className="grid gap-2">
          {props.items.map((item, index) => (
            <div className="grid gap-1 border-b border-zinc-100 pb-2 last:border-0 last:pb-0 sm:grid-cols-[160px_minmax(0,1fr)]" key={`${item.label}-${index}`}>
              <dt className="text-sm font-medium text-zinc-500">{item.label}</dt>
              <dd className="text-sm leading-relaxed text-zinc-800">{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    ),
    DataTable: ({ props }) => (
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
        <div className="overflow-auto">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead className="bg-zinc-50">
              <tr>
                {props.columns.map((column) => (
                  <th className="border-b border-zinc-200 px-3 py-2 text-left text-xs font-semibold text-zinc-500" key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row, rowIndex) => (
                <tr className="border-b border-zinc-100 last:border-0" key={rowIndex}>
                  {props.columns.map((column) => (
                    <td className="px-3 py-2 align-top leading-relaxed text-zinc-700" key={column}>
                      {String(row[column] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {props.caption ? <p className="border-t border-zinc-100 px-3 py-2 text-xs text-zinc-500">{props.caption}</p> : null}
      </div>
    ),
  },
});

export function JsonRenderReport({ spec }: { spec: Spec }) {
  return <Renderer registry={registry} spec={spec} />;
}
