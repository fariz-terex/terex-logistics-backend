const test = require("node:test");
const assert = require("node:assert/strict");
const { matchClusterName } = require("../src/utils/bkbParser");

const CLUSTERS = ["ACEH-1", "ACEH-2", "ACEH-3", "BANTEN-1", "JABAR-1B", "KALTENG-1"];

test("matchClusterName finds a cluster in a file name, ignoring spaces/dashes/case", () => {
  assert.equal(matchClusterName("NOD 4885317 - JABAR 1B.pdf", CLUSTERS), "JABAR-1B");
  assert.equal(matchClusterName("bkb aceh-2 sept.pdf", CLUSTERS), "ACEH-2");
  assert.equal(matchClusterName("BKB_KALTENG1.jpg", CLUSTERS), "KALTENG-1");
});

test("matchClusterName returns null when no cluster appears", () => {
  assert.equal(matchClusterName("BAPM Site MP Waan.pdf", CLUSTERS), null);
  assert.equal(matchClusterName("", CLUSTERS), null);
  assert.equal(matchClusterName(undefined, CLUSTERS), null);
});

test("matchClusterName prefers the longest match", () => {
  assert.equal(matchClusterName("JABAR-1B", ["JABAR-1", "JABAR-1B"]), "JABAR-1B");
});
