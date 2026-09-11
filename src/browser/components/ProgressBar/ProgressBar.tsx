import { cn } from "@/common/lib/utils";

interface ProgressBarProps {
  value: number;
  className?: string;
  "aria-label"?: string;
}

export function ProgressBar(props: ProgressBarProps) {
  return (
    <div
      role="progressbar"
      aria-valuenow={props.value}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={props["aria-label"]}
      className={cn("bg-init-output-bg h-1.5 overflow-hidden rounded-full", props.className)}
    >
      <div className="bg-accent h-full rounded-full" style={{ width: `${props.value}%` }} />
    </div>
  );
}
