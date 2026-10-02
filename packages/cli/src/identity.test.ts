import { describe, expect, it } from "vitest";
import { folderIdentity, remoteKey } from "./identity.js";

describe("remoteKey", () => {
  it.each([
    ["https://github.com/Owner/Repo.git", "github.com/owner/repo"],
    ["https://user:s3cret@github.com/Owner/Repo", "github.com/owner/repo"],
    ["git@github.com:Owner/Repo.git", "github.com/owner/repo"],
    ["ssh://git@github.com:22/Owner/Repo.git", "github.com/owner/repo"],
    ["ssh://git@GitHub.com/Owner/Repo/", "github.com/owner/repo"],
    ["https://gitlab.com/group/sub/repo.git", "gitlab.com/group/sub/repo"],
    ["https://dev.azure.com/Org/Proj/_git/Repo", "dev.azure.com/org/proj/_git/repo"],
    ["git@ssh.dev.azure.com:v3/Org/Proj/Repo", "dev.azure.com/org/proj/_git/repo"],
    ["https://Org.visualstudio.com/DefaultCollection/Proj/_git/Repo", "org.visualstudio.com/proj/_git/repo"],
    ["Org@vs-ssh.visualstudio.com:v3/Org/Proj/Repo", "org.visualstudio.com/proj/_git/repo"],
    ["https://bitbucket.org/team/repo.git", "bitbucket.org/team/repo"],
  ])("%s → %s", (url, key) => {
    expect(remoteKey(url)).toBe(key);
  });

  it.each([
    "/home/dev/repo",
    "../repo",
    "file:///home/dev/repo",
    "C:\\code\\repo",
    "/tmp/x/repo", // a clone of a local path: the path is not an identity
    "",
    "localhost:repo",
  ])("%s is not a hosted repo", (url) => {
    expect(remoteKey(url)).toBeNull();
  });
});

describe("folderIdentity", () => {
  it("is stable per install and never contains the path", () => {
    const a = folderIdentity("/Users/jane/scratch", "install-1");
    expect(a).toEqual(folderIdentity("/Users/jane/scratch", "install-1"));
    expect(a.key).toMatch(/^dir:[0-9a-f]{16}$/);
    expect(a.label).toBe("scratch");
    expect(a.source).toBe("folder");
    expect(folderIdentity("/Users/jane/scratch", "install-2").key).not.toBe(a.key);
  });
});
