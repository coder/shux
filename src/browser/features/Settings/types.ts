import type { ReactNode } from "react";

export interface SettingsSection {
  id: string;
  label: string;
  icon: ReactNode;
  component: React.ComponentType;
  experimental?: boolean;
}
