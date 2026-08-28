import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/cd.yml"),
  "utf8",
);
const ciWorkflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/ci.yml"),
  "utf8",
);

describe("npm release trust boundary", () => {
  it("uses hosted production OIDC publication without a write token", () => {
    expect(workflow).toContain("runs-on: ubuntu-latest");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("npm publish");
    expect(workflow).toContain("--provenance");
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/u);
  });

  it("admits only the prepared main commit after exact successful push CI", () => {
    expect(workflow).toContain("Enforce exact-main successful CI");
    expect(workflow).toContain("needs.prepare_release.outputs.commit_sha");
    expect(workflow).toContain("refs/remotes/origin/main");
    expect(workflow).toContain("-f branch=main");
    expect(workflow).toContain("-f event=push");
    expect(workflow).toContain('-f head_sha="${EXPECTED_SHA}"');
    expect(workflow).toContain('conclusion == "success"');
  });

  it("fails closed on an unsupported release runtime", () => {
    expect(workflow).toContain("Verify release runtime");
    expect(workflow).toContain('ACTUAL_NODE%%.*');
    expect(workflow).toContain('"11.5.1"');
  });

  it("runs same-repository pull requests on explicit trusted runners only", () => {
    expect(ciWorkflow).toContain("pull_request:");
    expect(ciWorkflow).toContain("group: Public CI - Quarantined");
    expect(ciWorkflow).toContain("labels: [self-hosted, Linux, X64]");
    expect(ciWorkflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(ciWorkflow).not.toContain("pull_request_target");
    expect(ciWorkflow).not.toContain("fromJSON(vars.");
  });
});
