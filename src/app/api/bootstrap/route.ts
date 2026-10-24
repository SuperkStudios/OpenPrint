import { NextResponse } from "next/server";
import { z } from "zod";
import { MAX_BOOTSTRAP_FILAMENTS, MAX_HISTORY_ITEMS } from "@/domain/input-limits";
import { runOwnerBootstrap } from "@/lib/bootstrap";

const filamentSchema = z.object({
  material: z.enum(["PLA", "PLA_PLUS", "PETG", "ABS", "TPU", "NYLON", "RESIN"]),
  color: z.string().min(1),
  brand: z.string().min(1),
  startingGrams: z.number().int().positive().optional(),
  remainingGrams: z.number().int().nonnegative(),
  rollCostCents: z.number().int().nonnegative().optional(),
  assignedPrinterHistory: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        gramsUsed: z.number().nonnegative(),
        materialCostCents: z.number().int().nonnegative().optional(),
        completedAt: z.string().optional()
      })
    )
    .max(MAX_HISTORY_ITEMS)
    .optional(),
  ignoredPrinterHistory: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        gramsUsed: z.number().nonnegative(),
        completedAt: z.string().optional()
      })
    )
    .max(MAX_HISTORY_ITEMS)
    .optional()
});

// Setup repeats ignored history per spool and accepts both filament aliases.
// Bound their combined work before Zod can accumulate nested element errors.
const schema = z.preprocess((input, context) => {
  if (!input || typeof input !== "object") return input;
  const body = input as Record<string, unknown>;
  const filaments = Array.isArray(body.filaments) ? body.filaments : [];
  if (filaments.length > MAX_BOOTSTRAP_FILAMENTS) {
    context.addIssue({ code: "custom", path: ["filaments"], message: `At most ${MAX_BOOTSTRAP_FILAMENTS} filaments are allowed` });
    return z.NEVER;
  }
  let historyItems = 0;
  for (const filament of [body.filament, ...filaments]) {
    if (!filament || typeof filament !== "object") continue;
    const spool = filament as Record<string, unknown>;
    for (const key of ["assignedPrinterHistory", "ignoredPrinterHistory"]) {
      if (Array.isArray(spool[key])) historyItems += spool[key].length;
      if (historyItems > MAX_HISTORY_ITEMS) {
        context.addIssue({ code: "custom", message: `At most ${MAX_HISTORY_ITEMS} total bootstrap history items are allowed` });
        return z.NEVER;
      }
    }
  }
  return input;
}, z.object({
  owner: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(12)
  }),
  company: z.object({
    brandName: z.string().min(1),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    lowFilamentThresholdGrams: z.number().int().nonnegative().optional()
  }),
  printer: z.object({
    name: z.string().min(1),
    publicName: z.string().min(1),
    internalIp: z.string().min(1),
    controlApiUrl: z.string().url()
  }),
  filament: filamentSchema,
  filaments: z.array(filamentSchema).min(1).max(MAX_BOOTSTRAP_FILAMENTS).optional(),
  security: z.object({
    mediaTokenSecretSet: z.boolean(),
    backupPassphraseSet: z.boolean()
  }).optional()
}));

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    const result = await runOwnerBootstrap(input);
    return NextResponse.json({ ok: true, ownerId: result.ownerId }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Bootstrap failed" },
      { status: error instanceof Error && error.message === "Bootstrap is locked" ? 409 : 400 }
    );
  }
}
