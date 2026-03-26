import { coworkerLogSchema } from "@/lib/db/schema";

export type UrgentNotification = {
  shouldNotify: boolean;
  summary: string;
};

export function parseClawLog(input: unknown) {
  return coworkerLogSchema.parse(input);
}

export function evaluateUrgency(log: ReturnType<typeof parseClawLog>): UrgentNotification {
  if (log.status === "urgent_alert") {
    return { shouldNotify: true, summary: `URGENT ${log.taskType}` };
  }

  return { shouldNotify: false, summary: `${log.taskType}:${log.status}` };
}
