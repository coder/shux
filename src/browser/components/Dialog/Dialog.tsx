import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as VisuallyHiddenPrimitive from "@radix-ui/react-visually-hidden";
import { X } from "lucide-react";

import { cn } from "@/common/lib/utils";

/**
 * VisuallyHidden component for accessibility - hides content visually but keeps it available to screen readers.
 * Use this to wrap DialogTitle when you want a custom visible title but still need accessibility.
 */
const VisuallyHidden = VisuallyHiddenPrimitive.Root;

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // Dim painted on a pseudo-element so iOS/iPadOS 26 WebKit's status-bar edge
      // sampler ignores this fixed overlay (it samples background-color/backdrop-filter
      // on fixed elements; pseudo-elements/absolute children are skipped).
      "fixed inset-0 z-[1500] before:absolute before:inset-0 before:bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Whether to show the close button (default: true) */
    showCloseButton?: boolean;
    /** Maximum width of the dialog (default: max-w-lg) */
    maxWidth?: string;
    /** Maximum height of the dialog */
    maxHeight?: string;
  }
>(
  (
    {
      className,
      children,
      showCloseButton = true,
      maxWidth,
      maxHeight,
      style,
      onEscapeKeyDown,
      ...props
    },
    ref
  ) => (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        onEscapeKeyDown={(e) => {
          // Prevent Escape from propagating to global handlers (e.g., stream interrupt).
          // Radix uses capture phase for Escape, so we must use onEscapeKeyDown (not onKeyDown).
          e.stopPropagation();
          onEscapeKeyDown?.(e);
        }}
        className={cn(
          "bg-dark border-border fixed top-[50%] left-[50%] z-[1500] grid w-[90%] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
          !maxWidth && "max-w-lg",
          maxHeight && "overflow-y-auto",
          className
        )}
        style={{ ...(maxWidth && { maxWidth }), ...(maxHeight && { maxHeight }), ...style }}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close className="text-muted hover:text-foreground absolute top-4 right-4 rounded-sm transition-colors focus:outline-none disabled:pointer-events-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-left", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex justify-end gap-3 pt-4", className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-foreground text-lg font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-muted text-sm", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

// Utility components for modal content
const DialogInfo = ({
  children,
  className,
  id,
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
}) => (
  <div
    id={id}
    className={cn(
      "bg-modal-bg border border-border-medium rounded p-3 mb-5 text-[13px]",
      "[&_p]:m-0 [&_p]:mb-2 [&_p]:text-muted [&_p:last-child]:mb-0",
      "[&_code]:text-accent [&_code]:font-mono",
      className
    )}
  >
    {children}
  </div>
);
DialogInfo.displayName = "DialogInfo";

// Error/Warning display components
const ErrorSection = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => <div className={cn("my-4", className)}>{children}</div>;
ErrorSection.displayName = "ErrorSection";

const ErrorLabel = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div
    className={cn("text-[11px] text-foreground-secondary uppercase tracking-wide mb-2", className)}
  >
    {children}
  </div>
);
ErrorLabel.displayName = "ErrorLabel";

const ErrorCodeBlock = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => (
  <pre
    className={cn(
      "bg-background-secondary border border-border rounded p-3",
      "text-xs font-mono text-foreground overflow-auto whitespace-pre-wrap break-words leading-relaxed",
      "max-h-[400px]",
      className
    )}
  >
    {children}
  </pre>
);
ErrorCodeBlock.displayName = "ErrorCodeBlock";

const WarningBox = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn("bg-error-bg border-l-[3px] border-error rounded p-3 px-4 my-4", className)}>
    {children}
  </div>
);
WarningBox.displayName = "WarningBox";

const WarningTitle = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => <div className={cn("font-semibold text-[13px] text-error mb-1", className)}>{children}</div>;
WarningTitle.displayName = "WarningTitle";

const WarningText = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => <div className={cn("text-[13px] text-foreground leading-normal", className)}>{children}</div>;
WarningText.displayName = "WarningText";

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogInfo,
  ErrorSection,
  ErrorLabel,
  ErrorCodeBlock,
  WarningBox,
  WarningTitle,
  WarningText,
  VisuallyHidden,
};
