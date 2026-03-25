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

export type Business = z.infer<typeof businessSchema>;
export type CoworkerLog = z.infer<typeof coworkerLogSchema>;
