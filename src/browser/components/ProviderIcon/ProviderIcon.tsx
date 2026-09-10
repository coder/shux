import React from "react";
import { Server } from "lucide-react";
import AnthropicIcon from "@/browser/assets/icons/anthropic.svg?react";
import OpenAIIcon from "@/browser/assets/icons/openai.svg?react";
import GoogleIcon from "@/browser/assets/icons/google.svg?react";
import XAIIcon from "@/browser/assets/icons/xai.svg?react";
import OpenRouterIcon from "@/browser/assets/icons/openrouter.svg?react";
import OllamaIcon from "@/browser/assets/icons/ollama.svg?react";
import DeepSeekIcon from "@/browser/assets/icons/deepseek.svg?react";
import MoonshotAIIcon from "@/browser/assets/icons/moonshotai.svg?react";
import ZaiIcon from "@/browser/assets/icons/zai.svg?react";
import AWSIcon from "@/browser/assets/icons/aws.svg?react";
import GitHubIcon from "@/browser/assets/icons/github.svg?react";
import CoderIcon from "@/browser/assets/icons/coder.svg?react";
import { GatewayIcon } from "@/browser/components/icons/GatewayIcon/GatewayIcon";
import {
  PROVIDER_DEFINITIONS,
  PROVIDER_DISPLAY_NAMES,
  type ProviderName,
} from "@/common/constants/providers";
import { cn } from "@/common/lib/utils";

/**
 * Provider icons mapped by provider name.
 * When adding a new provider, add its icon import above and entry here.
 */
const PROVIDER_ICONS: Partial<Record<ProviderName, React.FC>> = {
  anthropic: AnthropicIcon,
  openai: OpenAIIcon,
  google: GoogleIcon,
  xai: XAIIcon,
  deepseek: DeepSeekIcon,
  moonshotai: MoonshotAIIcon,
  zai: ZaiIcon,
  openrouter: OpenRouterIcon,
  bedrock: AWSIcon,
  ollama: OllamaIcon,
  "mux-gateway": GatewayIcon,
  "github-copilot": GitHubIcon,
  coder: CoderIcon,
};

/**
 * Check if a provider has an icon available.
 */
export function hasProviderIcon(provider: string): boolean {
  return provider in PROVIDER_ICONS;
}

export interface ProviderIconProps {
  provider: string;
  className?: string;
}

/**
 * Renders a provider's icon with a neutral fallback for custom providers.
 * Icons are sized to 1em by default to match surrounding text.
 */
export function ProviderIcon(props: ProviderIconProps) {
  const providerName = props.provider as ProviderName;
  const IconComponent = PROVIDER_ICONS[providerName];

  // Check if this provider uses stroke-based icon styling (from PROVIDER_DEFINITIONS).
  // Unknown custom providers use the fallback lucide icon, which is stroke based.
  const def = PROVIDER_DEFINITIONS[providerName] as { strokeBasedIcon?: boolean } | undefined;
  const isStrokeBased = IconComponent ? (def?.strokeBasedIcon ?? false) : true;

  return (
    <span
      className={cn(
        "inline-block h-[1em] w-[1em] align-[-0.125em] [&_svg]:block [&_svg]:h-full [&_svg]:w-full",
        // Stroke-based icons (like GatewayIcon) use stroke for color, others use fill.
        isStrokeBased
          ? "[&_svg]:stroke-current [&_svg]:fill-none"
          : "[&_svg]:fill-current [&_svg_.st0]:fill-current",
        props.className
      )}
    >
      {IconComponent ? <IconComponent /> : <Server />}
    </span>
  );
}

export interface ProviderWithIconProps {
  provider: string;
  className?: string;
  iconClassName?: string;
  /** Show display name instead of raw provider key */
  displayName?: boolean;
}

/**
 * Renders a provider name with its icon.
 * Custom providers use the neutral fallback icon.
 */
export function ProviderWithIcon(props: ProviderWithIconProps) {
  const name = props.displayName
    ? (PROVIDER_DISPLAY_NAMES[props.provider as ProviderName] ?? props.provider)
    : props.provider;

  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap", props.className)}>
      <ProviderIcon provider={props.provider} className={props.iconClassName} />
      <span>{name}</span>
    </span>
  );
}
