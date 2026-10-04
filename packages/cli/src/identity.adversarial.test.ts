// Adversarial: the claim is ONE key per repo, whatever URL shape a checkout
// carries, and NEVER a path or username on the wire. Each class below is a
// set of remotes that name one repo; every member must fold to the same key,
// and no two classes may collide.
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { displayLabel, folderIdentity, remoteKey } from "./identity.js";

const CLASSES: Record<string, string[]> = {
  "github.com/acme/repo": [
    "https://github.com/Acme/Repo.git",
    "https://github.com/acme/repo",
    "https://github.com/acme/repo/",
    "https://github.com/acme/repo.git/",
    "https://oauth2:ghp_secret@github.com/acme/repo.git",
    "https://github.com:443/acme/repo",
    "git@github.com:acme/repo.git",
    "git@github.com:/acme/repo.git",
    "github.com:acme/repo",
    "ssh://git@github.com:22/acme/repo.git",
    "ssh://github.com/acme/repo",
    "HTTPS://GITHUB.COM/ACME/REPO.GIT",
    "  https://github.com/acme/repo.git\n",
  ],
  "gitlab.com/g/sub/deep/repo": [
    "https://gitlab.com/g/sub/deep/repo.git",
    "git@gitlab.com:g/sub/deep/repo.git",
    "ssh://git@gitlab.com:2222/g/sub/deep/repo.git",
  ],
  "dev.azure.com/org/proj/_git/repo": [
    "https://dev.azure.com/org/proj/_git/repo",
    "https://org@dev.azure.com/org/proj/_git/repo",
    "git@ssh.dev.azure.com:v3/org/proj/repo",
    "ssh://git@ssh.dev.azure.com/v3/org/proj/repo",
    "ssh://git@ssh.dev.azure.com:22/v3/org/proj/repo",
  ],
  "dev.azure.com/org/my%20proj/_git/repo": [
    "https://dev.azure.com/org/My%20Proj/_git/repo",
    "git@ssh.dev.azure.com:v3/org/My%20Proj/repo",
  ],
  "org.visualstudio.com/proj/_git/repo": [
    "https://org.visualstudio.com/DefaultCollection/proj/_git/repo",
    "https://org.visualstudio.com/proj/_git/repo",
    "org@vs-ssh.visualstudio.com:v3/org/proj/repo",
  ],
  "git.corp.example/team/repo": [
    "ssh://git@git.corp.example:7999/team/repo.git",
    "https://git.corp.example/team/repo.git",
    "git@git.corp.example:team/repo",
  ],
  "bitbucket.org/team/repo": ["https://jane@bitbucket.org/team/repo.git", "git@bitbucket.org:team/repo.git"],
};

describe("remoteKey equivalence classes", () => {
  it.each(Object.entries(CLASSES).flatMap(([key, urls]) => urls.map((u) => [u, key] as const)))(
    "%j → %s",
    (url, key) => {
      expect(remoteKey(url)).toBe(key);
    },
  );

  it("no two classes collide", () => {
    const keys = Object.keys(CLASSES).map((k) => remoteKey(`https://${k}`));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each([
    ["https://github.com/acme/repo", "https://github.com/acme/repo2"],
    ["https://github.com/acme/repo", "https://github.com/acme-org/repo"],
    ["https://github.com/acme/repo", "https://gitlab.com/acme/repo"],
    ["https://github.com/acme/repo", "https://github.com/acme/repo.js"],
    ["https://dev.azure.com/org/proj/_git/repo", "https://dev.azure.com/org/proj2/_git/repo"],
    ["git@gitlab.com:g/repo.git", "git@gitlab.com:g/sub/repo.git"],
  ])("%s and %s are different repos", (a, b) => {
    expect(remoteKey(a)).not.toBeNull();
    expect(remoteKey(a)).not.toBe(remoteKey(b));
  });

  it.each([
    "/home/dev/repo",
    "../repo",
    "./foo:bar",
    "~/repos/x",
    "file:///home/dev/repo",
    "C:\\code\\repo",
    "c:/code/repo",
    "localhost:repo",
    "https://localhost/x/y",
    "http://[::1]/x/y",
    "https://github.com/",
    "https://github.com",
    "git@github.com:",
    "",
    "   ",
    "not a url at all",
  ])("%j is not a hosted repo", (url) => {
    expect(remoteKey(url)).toBeNull();
  });

  // A self-hosted remote names a machine and a folder on it, not a hosted
  // repo: as a key it would put a hostname, a LAN address or a home path on
  // the wire. These fall back to the root sha, which is the same for every
  // clone anyway.
  it.each([
    ["mDNS host, absolute path", "alice-macbook.local:/Users/alice/src/acme-secret.git"],
    ["mDNS host, ssh URL", "ssh://alice@alice-macbook.local/srv/git/proj.git"],
    ["private IPv4, ssh URL", "ssh://alice@192.168.1.20/home/alice/repos/proj.git"],
    ["private IPv4, scp", "git@10.0.0.5:team/repo.git"],
    ["public IPv4", "git@203.0.113.7:acme/repo.git"],
    ["IPv4 over https", "https://172.16.4.2:8443/team/repo.git"],
    ["IPv6 literal", "ssh://git@[fd00::1]/srv/repo.git"],
    ["localhost with a port", "ssh://git@localhost:2222/team/repo.git"],
    ["a .localhost name", "https://git.localhost/team/repo.git"],
    ["a router's LAN name", "nas.lan:repos/proj.git"],
    ["a .home.arpa name", "git@pi.home.arpa:team/repo.git"],
    ["a .localdomain name", "box.localdomain:team/repo.git"],
    ["scp absolute path on a named server", "devbox.corp.example:/home/alice/repos/proj.git"],
    ["scp home-relative path", "devbox.corp.example:~/repos/proj.git"],
    ["scp another user's home", "git@devbox.corp.example:~alice/proj.git"],
    ["ssh URL into a home", "ssh://alice@devbox.corp.example/~alice/proj.git"],
    ["file URL", "file:///Users/alice/repos/acme-secret.git"],
    // A dotless host is an ssh config alias or a bare machine name: not the
    // repo's canonical host, and a key the server rejects.
    ["ssh config alias, scp", "github-work:acme/repo.git"],
    ["ssh config alias with a user", "git@gh:acme/repo.git"],
    ["ssh config alias, ssh URL", "ssh://git@gh-work/acme/repo.git"],
    ["bare machine name", "nas:repos/proj.git"],
  ])("%s (%s) is not a key", (_, url) => {
    expect(remoteKey(url)).toBeNull();
  });

  it("a key never carries whitespace, credentials or a scheme", () => {
    for (const urls of Object.values(CLASSES)) {
      for (const u of urls) {
        const k = remoteKey(u)!;
        expect(k).toMatch(/^[a-z0-9.-]+\/\S+$/);
        expect(k).not.toMatch(/secret|@|:\/\//);
      }
    }
  });
});

describe("labels never disclose the username", () => {
  const user = basename(homedir());
  it.each([
    ["the home directory itself", homedir()],
    ["the home directory with a trailing slash", `${homedir()}/`],
  ])("%s labels as ~", (_, path) => {
    expect(displayLabel(path)).toBe("~");
    expect(folderIdentity(path, "install").label).toBe("~");
  });

  it("a folder under home keeps its own name", () => {
    expect(displayLabel(join(homedir(), "scratch"))).toBe("scratch");
  });

  it("a folder elsewhere that happens to be named like the user keeps it — it is not the home path", () => {
    expect(displayLabel(join("/srv", user))).toBe(user);
  });
});
