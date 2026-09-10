import React from "react";

interface GatewayIconProps extends React.SVGProps<SVGSVGElement> {
  className?: string;
  /** When true, shows the active/enabled state with double ring */
  active?: boolean;
}

/**
 * Gateway icon - represents routing through Xum Gateway.
 * Circle with M logo. Active state adds outer ring.
 */
export const GatewayIcon = React.forwardRef<SVGSVGElement, GatewayIconProps>(
  function GatewayIcon(props, ref) {
    const { active, ...svgProps } = props;

    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        {...svgProps}
      >
        {/* Outer glow ring when active */}
        {active && <circle cx="12" cy="12" r="11" strokeWidth="1" opacity="0.5" />}
        {/* Main circle */}
        <circle cx="12" cy="12" r="8" />
        {/* M letter */}
        <path d="M8 16V8l4 5 4-5v8" />
      </svg>
    );
  }
);

GatewayIcon.displayName = "GatewayIcon";
