import { Expand, LogIn, LogOut, Scan, SquareArrowOutUpRight } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { stopKeyboardPropagation } from "@/browser/utils/events";

interface DesktopToolbarProps {
  connected: boolean;
  controlling: boolean;
  scaleToFit: boolean;
  onToggleControl: () => void;
  onToggleScale: () => void;
  onDetach?: () => void;
  onBringBack?: () => void;
}

export function DesktopToolbar(props: DesktopToolbarProps) {
  const controlLabel = props.controlling ? "Release control" : "Take control";
  const zoomLabel = props.scaleToFit ? "Zoom to 100%" : "Zoom to fit";
  const actions = [
    {
      label: controlLabel,
      key: "c",
      icon: props.controlling ? LogOut : LogIn,
      action: props.onToggleControl,
      disabled: !props.connected,
      pressed: props.controlling,
    },
    {
      label: zoomLabel,
      key: "z",
      icon: props.scaleToFit ? Expand : Scan,
      action: props.onToggleScale,
      disabled: !props.connected,
      pressed: !props.scaleToFit,
    },
    ...(props.onDetach
      ? [
          {
            label: "Detach",
            key: "d",
            icon: SquareArrowOutUpRight,
            action: props.onDetach,
            disabled: !props.connected,
            pressed: undefined,
          },
        ]
      : []),
    ...(props.onBringBack
      ? [
          {
            label: "Bring back",
            key: "b",
            icon: LogIn,
            action: props.onBringBack,
            disabled: false,
            pressed: undefined,
          },
        ]
      : []),
  ];
  return (
    <div
      role="toolbar"
      aria-label="Desktop controls"
      className="border-border-light flex shrink-0 justify-end gap-1 border-b p-1"
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
        const action = actions.find((item) => item.key === event.key.toLowerCase());
        if (action && !action.disabled) {
          event.preventDefault();
          stopKeyboardPropagation(event);
          action.action();
        }
      }}
    >
      {actions.map((item) => (
        <Button
          key={item.key}
          variant="ghost"
          size="sm"
          className="text-muted-foreground h-7 gap-1.5 px-2 text-xs"
          aria-label={item.label}
          aria-pressed={item.pressed}
          aria-keyshortcuts={item.key.toUpperCase()}
          tooltip={
            <>
              {item.label}
              <span className="hidden sm:inline"> ({item.key.toUpperCase()})</span>
            </>
          }
          disabled={item.disabled}
          onClick={item.action}
        >
          <item.icon aria-hidden className="h-3.5 w-3.5" />
          <span className="hidden @min-[460px]:inline">{item.label}</span>
        </Button>
      ))}
    </div>
  );
}
