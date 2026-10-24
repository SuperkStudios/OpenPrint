import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BOOTSTRAP_FILAMENTS, MAX_HISTORY_ITEMS, MAX_QUEUE_ITEMS, MAX_SUPPORTED_MATERIALS } from "./input-limits";
import { printerProfileSchema } from "./printer-profile";

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  requireAdmin: vi.fn(),
  reorder: vi.fn(),
  authenticate: vi.fn(),
  findSetting: vi.fn(),
  saveSetting: vi.fn(),
  sync: vi.fn()
}));
vi.mock("@/lib/bootstrap", () => ({ runOwnerBootstrap: mocks.bootstrap }));
vi.mock("@/lib/http", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/services/queue", () => ({ reorderPrintQueue: mocks.reorder }));
vi.mock("@/services/supernode-jobs", () => ({ authenticateSuperNode: mocks.authenticate }));
vi.mock("@/services/printer-heartbeat", () => ({ syncManualPrintEventsFromHistory: mocks.sync }));
vi.mock("@/lib/prisma", () => ({ prisma: { systemSetting: { findUnique: mocks.findSetting, upsert: mocks.saveSetting } } }));

import { POST as bootstrap } from "../app/api/bootstrap/route";
import { POST as history } from "../app/api/supernode/printer-history/route";
import { POST as queue } from "../app/api/admin/queue/route";

const spool = { material: "PLA", color: "Black", brand: "Test", remainingGrams: 500 };
const print = { id: "print-1", name: "clip.gcode", status: "COMPLETED", gramsUsed: 10 };
const bootstrapPrint = { id: "print-1", name: "clip.gcode", gramsUsed: 10 };
const setup = {
  owner: { name: "Owner", email: "owner@example.com", password: "synthetic-password" },
  company: { brandName: "Print Shop" },
  printer: { name: "printer-1", publicName: "Printer One", internalIp: "127.0.0.1", controlApiUrl: "http://127.0.0.1" },
  filament: spool
};
const request = (body: unknown) => new Request("http://localhost/api/test", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bootstrap.mockResolvedValue({ ownerId: "owner-1" });
  mocks.requireAdmin.mockResolvedValue({ session: { user: { id: "admin-1" } } });
  mocks.reorder.mockResolvedValue([]);
  mocks.authenticate.mockResolvedValue({ nodeId: "node-1", printerId: "printer-1" });
  mocks.findSetting.mockResolvedValue({ value: [] });
  mocks.saveSetting.mockResolvedValue({});
  mocks.sync.mockResolvedValue({ updated: 0 });
});

describe("bounded collection validation", () => {
  it.each([null, {}])("rejects oversized SuperNode history with one issue before authentication (%j)", async (element) => {
    await expect(history(request({ nodeId: "node-1", completedPrints: Array(MAX_HISTORY_ITEMS + 1).fill(element) })))
      .rejects.toMatchObject({ issues: [{ code: "too_big", path: ["completedPrints"] }] });
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.saveSetting).not.toHaveBeenCalled();
  });

  it("accepts a full history at the limit and preserves the omitted-history default", async () => {
    const completedPrints = Array.from({ length: MAX_HISTORY_ITEMS }, (_, index) => ({ ...print, id: `print-${index}` }));
    const result = await history(request({ nodeId: "node-1", completedPrints }));
    expect(await result.json()).toMatchObject({ accepted: true, count: MAX_HISTORY_ITEMS });
    expect(mocks.saveSetting.mock.calls[0][0].create.value).toEqual(completedPrints);
    const empty = await history(request({ nodeId: "node-1" }));
    expect(await empty.json()).toMatchObject({ accepted: true, count: 0 });
  });

  it.each([null, {}])("rejects oversized queue IDs without accumulating element errors (%j)", async (element) => {
    await expect(queue(request({ action: "reorder", orderedIds: Array(MAX_QUEUE_ITEMS + 1).fill(element) })))
      .rejects.toMatchObject({ issues: [{ code: "too_big", path: ["orderedIds"] }] });
    expect(mocks.reorder).not.toHaveBeenCalled();
  });

  it("preserves queue ordering and the optional IDs default", async () => {
    const ids = Array.from({ length: MAX_QUEUE_ITEMS }, (_, index) => `job-${index}`);
    await queue(request({ action: "reorder", orderedIds: ids }));
    expect(mocks.reorder).toHaveBeenLastCalledWith(ids);
    await queue(request({ action: "reorder" }));
    expect(mocks.reorder).toHaveBeenLastCalledWith([]);
  });

  it.each(["assignedPrinterHistory", "ignoredPrinterHistory"])("bounds bootstrap %s in both filament representations", async (key) => {
    for (const body of [
      { ...setup, filament: { ...spool, [key]: Array(MAX_HISTORY_ITEMS + 1).fill(null) } },
      { ...setup, filaments: [{ ...spool, [key]: Array(MAX_HISTORY_ITEMS + 1).fill({}) }] }
    ]) {
      const response = await bootstrap(request(body));
      expect(response.status).toBe(400);
      expect(JSON.parse((await response.json()).error)).toHaveLength(1);
      expect(mocks.bootstrap).not.toHaveBeenCalled();
    }
  });

  it("bounds combined histories before validating nested elements", async () => {
    const response = await bootstrap(request({
      ...setup,
      filament: { ...spool, assignedPrinterHistory: Array(5_000).fill(null) },
      filaments: [{ ...spool, ignoredPrinterHistory: Array(5_001).fill({}) }]
    }));
    expect(response.status).toBe(400);
    expect(JSON.parse((await response.json()).error)).toHaveLength(1);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });

  it("bounds the outer bootstrap spool collection before visiting invalid spools", async () => {
    const response = await bootstrap(request({ ...setup, filaments: Array(MAX_BOOTSTRAP_FILAMENTS + 1).fill(null) }));
    expect(response.status).toBe(400);
    expect(JSON.parse((await response.json()).error)).toHaveLength(1);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });

  it("accepts full bootstrap history, ordinary aliases, and optional histories", async () => {
    const full = { ...setup, filament: { ...spool, assignedPrinterHistory: Array(MAX_HISTORY_ITEMS).fill(bootstrapPrint) } };
    expect((await bootstrap(request(full))).status).toBe(201);
    expect(mocks.bootstrap.mock.lastCall?.[0].filament.assignedPrinterHistory).toHaveLength(MAX_HISTORY_ITEMS);
    expect(mocks.bootstrap.mock.lastCall?.[0].filament.assignedPrinterHistory[0]).toEqual(bootstrapPrint);
    const aliases = { ...setup, filaments: [{ ...spool, ignoredPrinterHistory: [bootstrapPrint] }] };
    expect((await bootstrap(request(aliases))).status).toBe(201);
    expect(mocks.bootstrap).toHaveBeenLastCalledWith(aliases);
    expect((await bootstrap(request({ ...setup, filaments: Array(MAX_BOOTSTRAP_FILAMENTS).fill(spool) }))).status).toBe(201);
  });

  it("bounds printer material errors and preserves deduplication at the limit", () => {
    const schema = printerProfileSchema.shape.supportedMaterials;
    const result = schema.safeParse(Array(MAX_SUPPORTED_MATERIALS + 1).fill(null));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toMatchObject([{ code: "too_big", path: [] }]);
    expect(schema.parse(Array(MAX_SUPPORTED_MATERIALS).fill("PLA"))).toEqual(["PLA"]);
    expect(schema.parse(["PLA", "PETG", "PLA"])).toEqual(["PLA", "PETG"]);
  });
});
