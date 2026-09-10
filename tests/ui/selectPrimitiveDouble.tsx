/**
 * Conditional-rendering stand-in for SelectPrimitive used with bun's
 * mock.module in happy-dom unit tests: Radix Select portals its content, which
 * happy-dom cannot render, so option clicks are impossible against the real
 * component. Register it inside the test file with
 * `void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () =>
 *   createSelectPrimitiveDouble());`
 */
import React from "react";

export function createSelectPrimitiveDouble() {
  const SelectContext = React.createContext<{
    value?: string;
    disabled?: boolean;
    open: boolean;
    options: Map<string, React.ReactNode>;
    onValueChange?: (value: string) => void;
    setOpen: (open: boolean) => void;
  } | null>(null);

  function collectOptions(children: React.ReactNode, options = new Map<string, React.ReactNode>()) {
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement<{ value?: string; children?: React.ReactNode }>(child)) {
        return;
      }

      if (typeof child.props.value === "string") {
        options.set(child.props.value, child.props.children);
      }

      if (child.props.children) {
        collectOptions(child.props.children, options);
      }
    });

    return options;
  }

  function Select(props: {
    value?: string;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
    children: React.ReactNode;
  }) {
    const [open, setOpen] = React.useState(false);
    const options = collectOptions(props.children);
    return (
      <SelectContext.Provider
        value={{
          value: props.value,
          disabled: props.disabled,
          open,
          options,
          onValueChange: props.onValueChange,
          setOpen,
        }}
      >
        {props.children}
      </SelectContext.Provider>
    );
  }

  const SelectTrigger = React.forwardRef<
    HTMLButtonElement,
    React.ComponentPropsWithoutRef<"button">
  >((props, ref) => {
    const context = React.useContext(SelectContext);
    return (
      <button
        {...props}
        ref={ref}
        type="button"
        role="combobox"
        disabled={context?.disabled}
        aria-expanded={context?.open ?? false}
        onPointerDown={(event) => {
          props.onPointerDown?.(event);
          if (!context?.disabled) {
            context?.setOpen(true);
          }
        }}
      >
        {props.children}
      </button>
    );
  });
  SelectTrigger.displayName = "MockSelectTrigger";

  function SelectValue() {
    const context = React.useContext(SelectContext);
    return <span>{context?.options.get(context?.value ?? "") ?? context?.value ?? ""}</span>;
  }

  function SelectContent(props: { children: React.ReactNode }) {
    const context = React.useContext(SelectContext);
    return context?.open ? <div>{props.children}</div> : null;
  }

  function SelectItem(props: { value: string; children: React.ReactNode }) {
    const context = React.useContext(SelectContext);
    return (
      <button
        type="button"
        onClick={() => {
          context?.onValueChange?.(props.value);
          context?.setOpen(false);
        }}
      >
        {props.children}
      </button>
    );
  }

  return {
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
  };
}
