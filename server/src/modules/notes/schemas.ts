import { z } from 'zod';

export const soapSummarySchema = z.object({
  subjective: z.string().max(10_000),
  objective: z.string().max(10_000),
  assessment: z.string().max(10_000),
  plan: z.string().max(10_000),
  followUps: z.array(z.string().max(1_000)).max(50).default([]),
  flags: z.array(z.string().max(1_000)).max(50).default([])
});

export const noteInputSchema = z.object({ note: z.string().min(20).max(20_000) });
