import { z } from "zod";

export const businessSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  ownerEmail: z.string().email(),
  tier: z.enum(["starter", "standard", "enterprise"]),
  status: z.enum(["online", "offline", "high_load"])
});

export const coworkerLogSchema = z.object({
  businessId: z.string().uuid(),
  taskType: z.enum(["call", "sms", "data_flow", "email"]),
  status: z.enum(["thinking", "success", "urgent_alert", "error"]),
  logPayload: z.record(z.string(), z.unknown()),
  createdAt: z.string()
});

export const dailyUsageSchema = z.object({
  id: z.string().uuid(),
  businessId: z.string().uuid(),
  usageDate: z.string(),
  voiceMinutesUsed: z.number().int().min(0),
  smsSent: z.number().int().min(0),
  callsMade: z.number().int().min(0),
  peakConcurrentCalls: z.number().int().min(0)
});

export type Business = z.infer<typeof businessSchema>;
export type CoworkerLog = z.infer<typeof coworkerLogSchema>;
export type DailyUsageSchema = z.infer<typeof dailyUsageSchema>;
