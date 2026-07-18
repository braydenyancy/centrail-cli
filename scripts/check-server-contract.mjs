const contractUrl =
  process.env.CENTRAIL_CONTRACT_URL ??
  "https://centrail.org/api/cli/capabilities";
const expectedWire = process.env.CENTRAIL_WIRE_VERSION ?? "1";
const expectedSurfaces = (process.env.CENTRAIL_EXPECTED_SURFACES ?? "")
  .split(",")
  .filter(Boolean);

if (expectedSurfaces.length === 0) {
  throw new Error("CENTRAIL_EXPECTED_SURFACES must contain at least one surface");
}

const response = await fetch(contractUrl);
if (!response.ok) {
  throw new Error(`server contract request failed: ${response.status}`);
}

const contract = await response.json();
if (!Array.isArray(contract.wireVersions) || !contract.wireVersions.includes(expectedWire)) {
  throw new Error(`deployed server does not accept wire version ${expectedWire}`);
}

const acceptedSurfaces = new Set(
  Array.isArray(contract.surfaces) ? contract.surfaces : [],
);
const missing = expectedSurfaces.filter((surface) => !acceptedSurfaces.has(surface));
if (missing.length > 0) {
  throw new Error(`deployed server does not accept surfaces: ${missing.join(", ")}`);
}

process.stdout.write(
  `server accepts wire ${expectedWire}: ${expectedSurfaces.join(", ")}\n`,
);
