import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { getTextContent, TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { cn } from "@/common/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent text-white shadow hover:bg-accent-dark",
        destructive: "bg-error text-white shadow-sm hover:bg-error/90",
        outline:
          "border border-border-medium bg-transparent shadow-sm hover:bg-hover hover:text-foreground",
        secondary: "bg-border-medium text-foreground shadow-sm hover:bg-border-darker",
        ghost: "hover:bg-hover hover:text-foreground",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        xs: "h-6 rounded-md px-3 text-[11px]",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  title?: React.ReactNode;
  tooltip?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      title,
      tooltip,
      children,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : "button";
    // Shared controls intentionally reinterpret `title` as our custom tooltip surface so callers
    // can keep using the prop they naturally reach for without falling back to a truncating native
    // browser tooltip.
    const resolvedTooltip = tooltip ?? title;
    const childElement =
      asChild &&
      React.isValidElement<{ "aria-label"?: string; "aria-labelledby"?: string }>(children)
        ? children
        : null;
    const hasExplicitAccessibleName =
      ariaLabel != null ||
      ariaLabelledBy != null ||
      childElement?.props["aria-label"] != null ||
      childElement?.props["aria-labelledby"] != null;
    const visibleLabel = getTextContent(children).trim();
    const tooltipLabel = getTextContent(resolvedTooltip).trim();
    // Icon-only buttons historically relied on `title` for an accessible name; preserve that
    // fallback when `title` is upgraded into our shared tooltip surface.
    const resolvedAriaLabel =
      hasExplicitAccessibleName || visibleLabel !== "" || tooltipLabel === ""
        ? ariaLabel
        : tooltipLabel;
    const button = (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        aria-label={resolvedAriaLabel}
        aria-labelledby={ariaLabelledBy}
        {...props}
      >
        {children}
      </Comp>
    );

    return <TooltipIfPresent tooltip={resolvedTooltip}>{button}</TooltipIfPresent>;
  }
);
Button.displayName = "Button";

export { Button };
