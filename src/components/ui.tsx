import { Loader2 } from "lucide-react";
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import { cn } from "../lib/utils";

type ButtonVariant = "primary" | "secondary" | "secondary-destructive";
type ButtonSize = "sm" | "md";
type ButtonShape = "default" | "square";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  loading?: boolean;
  shape?: ButtonShape;
  size?: ButtonSize;
  variant?: ButtonVariant;
};

export function Button({
  children,
  className,
  disabled,
  icon,
  loading,
  shape = "default",
  size = "md",
  variant = "secondary",
  ...props
}: ButtonProps) {
  const variantClass = {
    primary: "border-transparent bg-zinc-950 text-white shadow-sm hover:bg-zinc-800",
    secondary: "border-zinc-200 bg-white text-zinc-900 shadow-sm hover:bg-zinc-50",
    "secondary-destructive": "border-red-200 bg-white text-red-600 shadow-sm hover:border-red-300 hover:bg-red-50",
  }[variant];
  const sizeClass = size === "sm" ? "min-h-9 px-3 text-sm" : "min-h-10 px-4 text-sm";
  return (
    <button
      className={cn(
        "inline-flex min-w-0 cursor-pointer items-center justify-center gap-2 rounded-md border font-medium leading-none transition-colors disabled:pointer-events-none disabled:opacity-50",
        variantClass,
        sizeClass,
        shape === "square" && "aspect-square px-0",
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="size-4 animate-spin shrink-0" /> : icon}
      {children}
    </button>
  );
}

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  appearance?: "dot";
  variant?: "success" | "error" | "warning" | "neutral" | "teal-subtle";
};

export function Badge({ appearance, children, className, variant = "neutral", ...props }: BadgeProps) {
  const variantClass = {
    error: "border-red-200 bg-red-50 text-red-700",
    neutral: "border-zinc-200 bg-zinc-100 text-zinc-600",
    success: "border-emerald-200 bg-emerald-50 text-emerald-700",
    "teal-subtle": "border-teal-200 bg-teal-50 text-teal-800",
    warning: "border-amber-200 bg-amber-50 text-amber-700",
  }[variant];
  const dotClass = {
    error: "bg-red-500",
    neutral: "bg-zinc-500",
    success: "bg-emerald-500",
    "teal-subtle": "bg-teal-600",
    warning: "bg-amber-500",
  }[variant];
  return (
    <span
      className={cn("inline-flex min-h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium leading-none", variantClass, className)}
      {...props}
    >
      {appearance === "dot" ? <span className={cn("size-1.5 rounded-full", dotClass)} /> : null}
      {children}
    </span>
  );
}

type BannerProps = HTMLAttributes<HTMLDivElement> & {
  description?: ReactNode;
  title: ReactNode;
  variant?: "error" | "default";
};

export function Banner({ className, description, title, variant = "default", ...props }: BannerProps) {
  return (
    <div
      className={cn(
        "grid gap-1 rounded-md border bg-white p-4 text-sm text-zinc-900 shadow-sm",
        variant === "error" && "border-red-200 bg-red-50 text-red-700",
        className,
      )}
      role={variant === "error" ? "alert" : "status"}
      {...props}
    >
      <strong className="font-semibold">{title}</strong>
      {description ? <p className={cn("leading-relaxed text-zinc-600", variant === "error" && "text-red-700/80")}>{description}</p> : null}
    </div>
  );
}

type EmptyProps = HTMLAttributes<HTMLDivElement> & {
  contents?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  size?: "sm" | "md";
  title: ReactNode;
};

export function Empty({ className, contents, description, icon, size = "md", title, ...props }: EmptyProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 text-center text-zinc-500", size === "sm" && "gap-2", className)} {...props}>
      {icon ? <div className="inline-flex text-zinc-500">{icon}</div> : null}
      <div>
        <h2 className="text-base font-semibold leading-tight text-zinc-950">{title}</h2>
        {description ? <p className="mt-1 leading-relaxed text-zinc-500">{description}</p> : null}
      </div>
      {contents}
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "min-h-10 min-w-0 rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-950 outline-none transition focus:border-zinc-400 focus:ring-2 focus:ring-zinc-200",
        className,
      )}
      {...props}
    />
  );
}

export function Loader({ className, size = "md" }: { className?: string; size?: "sm" | "md" }) {
  return <Loader2 className={cn("animate-spin", size === "sm" ? "size-4" : "size-5", className)} />;
}

type TabsProps = HTMLAttributes<HTMLDivElement> & {
  onValueChange: (value: string) => void;
  size?: "sm" | "md";
  tabs: Array<{ label: ReactNode; value: string }>;
  value: string;
  variant?: "segmented";
};

export function Tabs({ className, onValueChange, size = "md", tabs, value, variant = "segmented", ...props }: TabsProps) {
  return (
    <div
      className={cn("inline-flex flex-wrap items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-100 p-1", size === "sm" && "text-sm", className)}
      data-variant={variant}
      role="tablist"
      {...props}
    >
      {tabs.map((tab) => (
        <button
          aria-selected={tab.value === value}
          className={cn(
            "inline-flex min-h-8 items-center justify-center gap-2 rounded-md px-3 font-medium text-zinc-600 transition-colors hover:text-zinc-950",
            tab.value === value && "bg-white text-zinc-950 shadow-sm",
          )}
          key={tab.value}
          role="tab"
          type="button"
          onClick={() => onValueChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

type TableComponent = ((props: TableHTMLAttributes<HTMLTableElement>) => ReactElement) & {
  Body: (props: HTMLAttributes<HTMLTableSectionElement>) => ReactElement;
  Cell: (props: TdHTMLAttributes<HTMLTableCellElement>) => ReactElement;
  Head: (props: ThHTMLAttributes<HTMLTableCellElement>) => ReactElement;
  Header: (props: HTMLAttributes<HTMLTableSectionElement>) => ReactElement;
  Row: (props: HTMLAttributes<HTMLTableRowElement>) => ReactElement;
};

export const Table = (({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) => (
  <table className={cn("w-full border-collapse text-sm", className)} {...props} />
)) as TableComponent;

Table.Header = function TableHeader({ className, ...props }) {
  return <thead className={cn("bg-zinc-50", className)} {...props} />;
};

Table.Body = function TableBody({ className, ...props }) {
  return <tbody className={cn("divide-y divide-zinc-100", className)} {...props} />;
};

Table.Row = function TableRow({ className, ...props }) {
  return <tr className={cn("border-b border-zinc-100 transition-colors hover:bg-zinc-50", className)} {...props} />;
};

Table.Head = function TableHead({ className, ...props }) {
  return <th className={cn("sticky top-0 z-10 border-r border-zinc-100 bg-zinc-50 px-3 py-2 text-left text-xs font-semibold text-zinc-600", className)} {...props} />;
};

Table.Cell = function TableCell({ className, ...props }) {
  return <td className={cn("max-w-72 min-w-30 border-r border-zinc-100 px-3 py-2 align-top leading-relaxed text-zinc-700 [overflow-wrap:anywhere]", className)} {...props} />;
};
