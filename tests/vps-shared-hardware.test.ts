import { describe, it, expect } from "vitest";
import {
  HQ_BUSINESS_ID,
  SHARED_HARDWARE,
  sharedHardwareFor,
  sharedHardwareForVm,
  sharedHardwareWarning,
  type SharedHardwareEntry
} from "@/lib/vps/shared-hardware";

describe("vps/shared-hardware", () => {
  it("registers the HQ box, and nothing else", () => {
    // A customer box must never appear here: the per-tenant isolation the
    // security posture sells depends on it. If this ever grows a second row,
    // it had better be another internal tenant.
    expect(SHARED_HARDWARE).toHaveLength(1);
    const [hq] = SHARED_HARDWARE;
    expect(hq.businessId).toBe(HQ_BUSINESS_ID);
    expect(hq.vmId).toBe(1806097);
    expect(hq.hostname).toBe("srv1806097.hstgr.cloud");
    expect(hq.vpsSize).toBe("kvm1");
    expect(hq.coTenants.map((c) => c.product)).toEqual(["JobArms"]);
  });

  it("records what a re-image would destroy on the HQ box", () => {
    const [{ coTenants }] = SHARED_HARDWARE;
    const [jobarms] = coTenants;
    expect(jobarms.units).toContain("jobarms-render.service");
    expect(jobarms.units).toContain("cloudflared-jobarms.service");
    expect(jobarms.port).toBe(8085);
    expect(jobarms.paths).toContain("/opt/jobarms-render");
    expect(jobarms.paths).toContain("/var/lib/jobarms-render");
    expect(jobarms.removal).toContain("systemctl disable");
  });

  it("does not collide with a port the platform stack already binds", () => {
    // Rowboat 3000, aiflow-render 8080, voice bridge 8090, data-api 8091,
    // llm-router 11435, host Ollama 11434.
    const taken = [3000, 8080, 8090, 8091, 11434, 11435];
    for (const entry of SHARED_HARDWARE) {
      for (const svc of entry.coTenants) {
        if (svc.port !== undefined) expect(taken).not.toContain(svc.port);
      }
    }
  });

  it("looks an entry up by business id", () => {
    expect(sharedHardwareFor(HQ_BUSINESS_ID)?.vmId).toBe(1806097);
  });

  it("returns null for a business whose box is ours alone", () => {
    expect(sharedHardwareFor("621a5b0d-0000-0000-0000-000000000000")).toBeNull();
    expect(sharedHardwareFor("")).toBeNull();
  });

  it("looks an entry up by Hostinger VM id, since an adopt run targets a VM", () => {
    expect(sharedHardwareForVm(1806097)?.businessId).toBe(HQ_BUSINESS_ID);
    expect(sharedHardwareForVm(1806114)).toBeNull();
  });

  it("renders a warning naming the box, the units, and the removal command", () => {
    const text = sharedHardwareWarning(SHARED_HARDWARE[0]);
    expect(text).toContain("VM 1806097 (srv1806097.hstgr.cloud) is SHARED HARDWARE.");
    expect(text).toContain("New Coworker (HQ, internal)");
    expect(text).toContain("DESTROYS the services below");
    expect(text).toContain("jobarms-render.service, cloudflared-jobarms.service");
    expect(text).toContain("127.0.0.1:8085");
    expect(text).toContain("/opt/jobarms-render, /var/lib/jobarms-render");
    expect(text).toContain("browser.jobarms.com");
    expect(text).toContain("systemctl disable --now jobarms-render cloudflared-jobarms");
  });

  it("omits the port and tunnel lines for a co-tenant that has neither", () => {
    // A co-tenant need not serve HTTP or own a tunnel (a cron job, a queue
    // consumer), and the warning must not print an empty field for it.
    const entry: SharedHardwareEntry = {
      businessId: "b-1",
      businessName: "Example",
      vmId: 42,
      hostname: "srv42.example",
      vpsSize: "kvm2",
      note: "hypothetical",
      coTenants: [
        {
          name: "batch-cruncher",
          product: "Somewhere Else",
          units: ["batch-cruncher.timer"],
          paths: ["/opt/batch"],
          removal: "systemctl disable --now batch-cruncher.timer"
        }
      ]
    };
    const text = sharedHardwareWarning(entry);
    expect(text).toContain("batch-cruncher.timer");
    expect(text).not.toContain("port   :");
    expect(text).not.toContain("tunnel :");
  });
});
