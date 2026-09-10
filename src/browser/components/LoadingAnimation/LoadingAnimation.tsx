import Lottie from "lottie-react";
import dancingBlinkAnimation from "@/browser/assets/animations/dancing-blink.json";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { useReducedMotion } from "@/browser/hooks/useReducedMotion";

interface LoadingAnimationProps {
  className?: string;
}

/**
 * Shared loading animation used for workspace loading and workspace creation screens.
 * (Initial boot uses the static XumLogo in LoadingScreen instead.)
 * Renders the dancing-blink Lottie animation with automatic light/dark theme handling.
 *
 * Respects prefers-reduced-motion: shows a static first frame when the user
 * has opted out of animations, matching the old CSS spinner behavior.
 */
export function LoadingAnimation(props: LoadingAnimationProps) {
  const { theme } = useTheme();
  const isDark = theme === "dark" || theme.endsWith("-dark");
  const prefersReducedMotion = useReducedMotion();

  return (
    <Lottie
      // Force remount when reduced-motion toggles at runtime — Lottie doesn't
      // dynamically respond to loop/autoplay prop changes on an active instance.
      key={String(prefersReducedMotion)}
      animationData={dancingBlinkAnimation}
      loop={!prefersReducedMotion}
      autoplay={!prefersReducedMotion}
      renderer="svg"
      aria-hidden="true"
      className={`w-[150px] ${isDark ? "brightness-0 invert" : ""} ${props.className ?? ""}`}
    />
  );
}
