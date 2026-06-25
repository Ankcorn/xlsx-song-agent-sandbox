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
  return (
    <button
      className={cn("ui-button", `ui-button-${variant}`, `ui-button-${size}`, shape === "square" && "ui-button-square", className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="ui-spinner" size={16} /> : icon}
      {children}
    </button>
  );
}

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  appearance?: "dot";
  variant?: "success" | "error" | "warning" | "neutral" | "teal-subtle";
};

export function Badge({ appearance, children, className, variant = "neutral", ...props }: BadgeProps) {
  return (
    <span className={cn("ui-badge", `ui-badge-${variant}`, appearance === "dot" && "ui-badge-dot", className)} {...props}>
      {appearance === "dot" ? <span className="ui-badge-indicator" /> : null}
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
    <div className={cn("ui-banner", `ui-banner-${variant}`, className)} role={variant === "error" ? "alert" : "status"} {...props}>
      <strong>{title}</strong>
      {description ? <p>{description}</p> : null}
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
    <div className={cn("ui-empty", `ui-empty-${size}`, className)} {...props}>
      {icon ? <div className="ui-empty-icon">{icon}</div> : null}
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {contents}
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("ui-input", className)} {...props} />;
}

export function Loader({ className, size = "md" }: { className?: string; size?: "sm" | "md" }) {
  return <Loader2 className={cn("ui-spinner", `ui-spinner-${size}`, className)} />;
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
    <div className={cn("ui-tabs", `ui-tabs-${size}`, `ui-tabs-${variant}`, className)} role="tablist" {...props}>
      {tabs.map((tab) => (
        <button
          aria-selected={tab.value === value}
          className={cn("ui-tab", tab.value === value && "active")}
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
  <table className={cn("ui-table", className)} {...props} />
)) as TableComponent;

Table.Header = function TableHeader({ className, ...props }) {
  return <thead className={cn("ui-table-header", className)} {...props} />;
};

Table.Body = function TableBody({ className, ...props }) {
  return <tbody className={cn("ui-table-body", className)} {...props} />;
};

Table.Row = function TableRow({ className, ...props }) {
  return <tr className={cn("ui-table-row", className)} {...props} />;
};

Table.Head = function TableHead({ className, ...props }) {
  return <th className={cn("ui-table-head", className)} {...props} />;
};

Table.Cell = function TableCell({ className, ...props }) {
  return <td className={cn("ui-table-cell", className)} {...props} />;
};
