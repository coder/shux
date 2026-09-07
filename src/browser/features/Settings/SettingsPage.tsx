import { useEffect } from "react";
import {
  ArrowLeft,
  Blocks,
  Brain,
  Menu,
  Settings,
  Key,
  Cpu,
  X,
  FlaskConical,
  Bot,
  Keyboard,
  Layout,
  Container,
  Shield,
  ShieldCheck,
  Server,
  Monitor,
  Lock,
  ArchiveRestore,
  ScrollText,
} from "lucide-react";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useOnboardingPause } from "@/browser/features/SplashScreens/SplashScreenProvider";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { isEditableElement, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { GeneralSection } from "./Sections/GeneralSection";
import { TasksSection } from "./Sections/TasksSection";
import { ProvidersSection } from "./Sections/ProvidersSection";
import { ModelsSection } from "./Sections/ModelsSection";
import { GovernorSection } from "./Sections/GovernorSection";
import { MemorySection } from "./Sections/MemorySection";
import { Button } from "@/browser/components/Button/Button";
import { MCPSettingsSection } from "./Sections/MCPSettingsSection";
import { PluginsSettingsSection } from "./Sections/PluginsSettingsSection";
import { SecretsSection } from "./Sections/SecretsSection";
import { InstructionsSection } from "./Sections/InstructionsSection";
import { LayoutsSection } from "./Sections/LayoutsSection";
import { RuntimesSection } from "./Sections/RuntimesSection";
import { ExperimentsSection } from "./Sections/ExperimentsSection";
import { ServerAccessSection } from "./Sections/ServerAccessSection";
import { RemoteConnectionSection } from "./Sections/RemoteConnectionSection";
import { KeybindsSection } from "./Sections/KeybindsSection";
import { SecuritySection } from "./Sections/SecuritySection";
import { BackupSection } from "./Sections/BackupSection";
import type { SettingsSection } from "./types";

const LEGACY_EXPERIMENT_SETTINGS_SECTION_IDS = new Set(["goals", "heartbeat"]);

const BASE_SECTIONS: SettingsSection[] = [
  {
    id: "general",
    label: "General",
    icon: <Settings className="h-4 w-4" />,
    component: GeneralSection,
  },
  {
    id: "tasks",
    label: "Agents",
    icon: <Bot className="h-4 w-4" />,
    component: TasksSection,
  },
  {
    id: "instructions",
    label: "Instructions",
    icon: <ScrollText className="h-4 w-4" />,
    component: InstructionsSection,
  },
  {
    id: "providers",
    label: "Providers",
    icon: <Key className="h-4 w-4" />,
    component: ProvidersSection,
  },
  {
    id: "models",
    label: "Models",
    icon: <Cpu className="h-4 w-4" />,
    component: ModelsSection,
  },
  {
    id: "mcp",
    label: "MCP",
    icon: <Server className="h-4 w-4" />,
    component: MCPSettingsSection,
  },
  {
    id: "secrets",
    label: "Secrets",
    icon: <Lock className="h-4 w-4" />,
    component: SecretsSection,
  },
  {
    id: "security",
    label: "Security",
    icon: <ShieldCheck className="h-4 w-4" />,
    component: SecuritySection,
  },
  {
    id: "server-access",
    label: "Server Access",
    icon: <Shield className="h-4 w-4" />,
    component: ServerAccessSection,
  },
  {
    id: "layouts",
    label: "Layouts",
    icon: <Layout className="h-4 w-4" />,
    component: LayoutsSection,
  },
  {
    id: "runtimes",
    label: "Runtimes",
    icon: <Container className="h-4 w-4" />,
    component: RuntimesSection,
  },
  {
    id: "experiments",
    label: "Experiments",
    icon: <FlaskConical className="h-4 w-4" />,
    component: ExperimentsSection,
  },
  {
    id: "keybinds",
    label: "Keybinds",
    icon: <Keyboard className="h-4 w-4" />,
    component: KeybindsSection,
  },
];

interface SettingsSectionRedirect {
  section: string;
  replace?: boolean;
}

export function getSettingsSections(
  governorEnabled: boolean,
  memoryEnabled: boolean,
  agentPluginsEnabled: boolean,
  remoteConnectionAvailable = false
): SettingsSection[] {
  const sections = [...BASE_SECTIONS];
  if (remoteConnectionAvailable) {
    const serverAccessIndex = sections.findIndex((section) => section.id === "server-access");
    sections.splice(serverAccessIndex + 1, 0, {
      id: "remote-connection",
      label: "Remote Connection",
      icon: <Monitor className="h-4 w-4 shrink-0" />,
      component: RemoteConnectionSection,
    });
  }
  if (agentPluginsEnabled) {
    // Next to MCP: plugins contribute skills + MCP servers.
    const mcpIndex = sections.findIndex((section) => section.id === "mcp");
    sections.splice(mcpIndex + 1, 0, {
      id: "plugins",
      label: "Plugins",
      icon: <Blocks className="h-4 w-4" />,
      component: PluginsSettingsSection,
      experimental: true,
    });
  }
  if (memoryEnabled) {
    sections.push({
      id: "memory",
      label: "Memory",
      icon: <Brain className="h-4 w-4" />,
      component: MemorySection,
    });
  }
  sections.push({
    id: "backup",
    label: "Backup",
    icon: <ArchiveRestore className="h-4 w-4" />,
    component: BackupSection,
    experimental: true,
  });
  if (governorEnabled) {
    sections.push({
      id: "governor",
      label: "Governor",
      icon: <ShieldCheck className="h-4 w-4" />,
      component: GovernorSection,
    });
  }
  return sections;
}

export function getSettingsSectionRedirect(
  activeSection: string,
  governorEnabled: boolean,
  memoryEnabled: boolean,
  agentPluginsEnabled: boolean,
  remoteConnectionAvailable = false
): SettingsSectionRedirect | null {
  if (LEGACY_EXPERIMENT_SETTINGS_SECTION_IDS.has(activeSection)) {
    return { section: "experiments", replace: true };
  }

  if (!governorEnabled && activeSection === "governor") {
    return { section: BASE_SECTIONS[0]?.id ?? "general" };
  }

  if (!memoryEnabled && activeSection === "memory") {
    return { section: BASE_SECTIONS[0]?.id ?? "general" };
  }

  if (!agentPluginsEnabled && activeSection === "plugins") {
    return { section: BASE_SECTIONS[0]?.id ?? "general" };
  }

  if (!remoteConnectionAvailable && activeSection === "remote-connection") {
    return { section: BASE_SECTIONS[0]?.id ?? "general" };
  }

  return null;
}

interface SettingsPageProps {
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
}

export function SettingsPage(props: SettingsPageProps) {
  const { close, activeSection, setActiveSection } = useSettings();
  const onboardingPause = useOnboardingPause();
  const governorEnabled = useExperimentValue(EXPERIMENT_IDS.MUX_GOVERNOR);
  const memoryEnabled = useExperimentValue(EXPERIMENT_IDS.MEMORY);
  const agentPluginsEnabled = useExperimentValue(EXPERIMENT_IDS.AGENT_PLUGINS);
  const remoteConnectionAvailable = window.api?.remoteConnection != null;

  // Redirect restored links when an experiment or desktop bridge is unavailable.
  useEffect(() => {
    const redirect = getSettingsSectionRedirect(
      activeSection,
      governorEnabled,
      memoryEnabled,
      agentPluginsEnabled,
      remoteConnectionAvailable
    );
    if (!redirect) {
      return;
    }

    if (redirect.replace) {
      setActiveSection(redirect.section, { replace: true });
      return;
    }

    setActiveSection(redirect.section);
  }, [
    activeSection,
    setActiveSection,
    governorEnabled,
    memoryEnabled,
    agentPluginsEnabled,
    remoteConnectionAvailable,
  ]);

  // Close settings on Escape. Uses bubble phase so inner surfaces (Select dropdowns,
  // Popover, Dialog) that call stopPropagation/preventDefault on Escape get first
  // right of refusal—only an unclaimed Escape navigates away from settings.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!matchesKeybind(e, KEYBINDS.CANCEL)) return;
      if (e.defaultPrevented) return;
      if (isEditableElement(e.target)) return;

      e.preventDefault();
      e.stopPropagation();
      close();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);
  const sections = getSettingsSections(
    governorEnabled,
    memoryEnabled,
    agentPluginsEnabled,
    remoteConnectionAvailable
  );
  const currentSection = sections.find((section) => section.id === activeSection) ?? sections[0];
  const SectionComponent = currentSection.component;

  return (
    <div className="bg-surface-primary flex min-h-0 flex-1 flex-col overflow-hidden">
      {/*
        Keep explicit mobile escape controls in the page chrome:
        - The desktop close button is hidden below md.
        - On touch layouts, the left sidebar is often off-canvas by default.
        Without back + menu actions here, /settings/:section can trap users in-pane.
      */}
      <div
        className="bg-surface-primary border-border-light flex shrink-0 items-center 
        justify-between border-b px-2 md:hidden [@media(max-width:768px)]:h-auto 
        [@media(max-width:768px)]:py-2"
      >
        <div className="flex min-w-0 items-center gap-2">
          {props.leftSidebarCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              onClick={props.onToggleLeftSidebarCollapsed}
              title="Open sidebar"
              aria-label="Open sidebar menu"
              className="mobile-menu-btn text-muted hover:text-foreground hidden h-6 w-6 shrink-0"
            >
              <Menu className="h-4 w-4" />
            </Button>
          )}
          <span className="text-foreground text-sm font-semibold">Settings</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={close}
          title="Back"
          aria-label="Back to previous page"
          className="text-muted hover:text-foreground px-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="border-border-medium hidden w-48 shrink-0 flex-col border-r md:flex">
          <div className="border-border-medium flex h-12 items-center border-b px-4">
            <span className="text-foreground text-sm font-semibold">Settings</span>
          </div>
          <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
            {sections.map((section) => (
              <Button
                key={section.id}
                variant="ghost"
                onClick={() => setActiveSection(section.id)}
                className={`flex h-auto w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-left text-sm ${
                  activeSection === section.id
                    ? "bg-accent/20 text-accent hover:bg-accent/20 hover:text-accent"
                    : "text-muted hover:bg-hover hover:text-foreground"
                }`}
              >
                {section.icon}
                {section.label}
                {section.experimental && (
                  <FlaskConical aria-hidden="true" className="text-warning h-3 w-3 shrink-0" />
                )}
              </Button>
            ))}
          </nav>
        </aside>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="border-border-medium shrink-0 border-b md:hidden">
            <nav className="flex gap-1 overflow-x-auto p-2">
              {sections.map((section) => (
                <Button
                  key={section.id}
                  variant="ghost"
                  onClick={() => setActiveSection(section.id)}
                  className={`flex h-auto shrink-0 items-center justify-start gap-2 rounded-md px-3 py-2 text-left text-sm whitespace-nowrap ${
                    activeSection === section.id
                      ? "bg-accent/20 text-accent hover:bg-accent/20 hover:text-accent"
                      : "text-muted hover:bg-hover hover:text-foreground"
                  }`}
                >
                  {section.icon}
                  {section.label}
                  {section.experimental && (
                    <FlaskConical aria-hidden="true" className="text-warning h-3 w-3 shrink-0" />
                  )}
                </Button>
              ))}
            </nav>
          </div>

          <div className="border-border-medium hidden h-12 items-center justify-between border-b px-6 md:flex">
            <span className="text-foreground text-sm font-medium">{currentSection.label}</span>
            <Button
              variant="ghost"
              size="icon"
              onClick={close}
              className="h-6 w-6"
              aria-label="Close settings"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 md:p-6">
            {/* Keep settings content width bounded so long forms remain readable on wide screens.
                min-h-full + flex-col lets full-height sections (Settings → Memory editor) grow to
                the bottom via flex-1 while content-sized sections keep their natural height. */}
            <div className="flex min-h-full w-full max-w-4xl flex-col">
              {onboardingPause.paused && (
                <div className="bg-accent/10 border-accent/30 text-foreground mb-3 flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span>Setup is paused while you configure providers.</span>
                  <Button variant="secondary" size="sm" onClick={close}>
                    Return to setup
                  </Button>
                </div>
              )}
              <SectionComponent />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
