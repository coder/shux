export interface TaskGroupArgsLike {
  n?: number | null;
}

export interface TaskGroupLaunchArgs extends TaskGroupArgsLike {
  prompt: string;
}

export interface TaskGroupLaunchDescriptor {
  index: number;
  total: number;
  prompt: string;
}

export function getTaskGroupCount(args: TaskGroupArgsLike | null | undefined): number {
  return args?.n ?? 1;
}

export function buildTaskGroupLaunches(args: TaskGroupLaunchArgs): TaskGroupLaunchDescriptor[] {
  const total = getTaskGroupCount(args);
  return Array.from({ length: total }, (_, index) => ({
    index,
    total,
    prompt: args.prompt,
  }));
}

export function formatTaskGroupSummary(total: number): string {
  return `Best of ${total}`;
}

export function formatTaskGroupHeader(total: number, title: string): string {
  return `${formatTaskGroupSummary(total)} · ${title}`;
}

export function formatTaskGroupMemberLabel(index: number): string {
  return `candidate ${index + 1}`;
}
