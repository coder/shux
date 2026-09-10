import { Button } from "@/browser/components/Button/Button";

interface StartupConnectionErrorProps {
  error: string;
  onRetry: () => void;
}

export function StartupConnectionError(props: StartupConnectionErrorProps) {
  return (
    <div className="boot-loader" role="alert" aria-live="polite">
      <div className="boot-loader__inner">
        <p className="boot-loader__text">Unable to connect to the Xum backend.</p>

        <p className="boot-loader__text max-w-[720px] text-center">
          <span className="font-medium">Details:</span> {props.error}
        </p>

        <p className="boot-loader__text max-w-[720px] text-center">
          If you&apos;re using a reverse proxy, ensure it supports WebSocket upgrades to{" "}
          <code>/orpc/ws</code>.
        </p>

        <Button onClick={props.onRetry}>Retry</Button>
      </div>
    </div>
  );
}
