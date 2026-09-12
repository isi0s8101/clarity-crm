export type DashboardRecord = {
  status?: string;
  data?: Record<string, unknown>;
};

export function summarizeDashboardRecords(input?: {
  opportunities?: DashboardRecord[];
  tasks?: DashboardRecord[];
  now?: Date;
}): {
  openOpportunities: number;
  pipelineAmountCents: number;
  stageCounts: Record<string, number>;
  wonOpportunities: number;
  openTasks: number;
  overdueTasks: number;
};
