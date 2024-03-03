export const ZeroIdStr = "0".repeat(40);
export const Zero = Buffer.from([0]);
export const PackHeader = Buffer.from("PACK");
export const FlushPkt = Buffer.from("0000");

export const ZeroId = Buffer.from(ZeroIdStr);
export const LF = Buffer.from("\n");
export const DataBand = Buffer.from([1]);
export const ProgressBand = Buffer.from([2]);
export const ErrorBand = Buffer.from([3]);
export function debug(...args) {
  if (process.env.GIT_DEBUG != null && +process.env.GIT_DEBUG === 1) {
    console.log.apply(this, arguments);
  }
}

export const Stages = {
  Initial: "Initial",
  PktLine: "PktLine",
  PackHeader: "PackHeader",
  PackData: "PackData",
  PackChecksum: "PackChecksum",
  Error: "Error",
  Final: "Final",
};

export const ObjectTypes = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
  7: "ref_delta",
};

export const ObjectNames = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
  ref_delta: 7,
};

export function isZeroId(id) {
  return id === ZeroIdStr;
}
/**
 * Parse a tree object and return the list of files and directories
 * @param {any} tree tree object (get it with getObject)
 * @returns {[{mode: number, name: string, sha: string}]}
 */
export function parseTree(tree) {
  if (tree.objectType != "tree" && tree.objectType != 2) throw new Error(`${tree.sha} is not a tree. (${tree.objectType})`)
  const treedata = tree.data;
  const entries = [];
  let offset = 0;
  while (offset < treedata.length) {
    let spaceIndex = treedata.indexOf(" ", offset);
    let mode = parseInt(treedata.toString("utf8", offset, spaceIndex));
    offset = spaceIndex + 1;

    let nullIndex = treedata.indexOf("\0", offset);
    let filename = treedata.toString("utf8", offset, nullIndex);
    offset = nullIndex + 1;

    let sha1 = treedata.slice(offset, offset + 20).toString("hex");
    offset += 20;
    entries.push({ mode, name: filename, sha: sha1 });
  }
  return entries;
}
/**
 * Parse a tag object and return the object, type, tagger and message
 * @param {any} tag tag object (get it with getObject)
 * @returns {object: string, type: string, tagger: string, message: string}
 */
export function parseTag(tag) {
  if (tag.objectType != "tag") throw new Error(`${tag.sha} is not a tag. (${tag.objectType})`)
  const tagdata = tag.data.toString("utf8").split("\n");
  const object = tagdata[0].split(" ")[1];
  const type = tagdata[0].split(" ")[0];
  const tagger = tagdata[1].split(" ")[1];
  const message = tagdata.slice(2).join("\n");
  return { object, type, tagger, message };
}
/**
 * Parse a commit object and return the tree, parent, author, committer and message
 * @param {any} commit commit object (get it with getObject) 
 * @returns {tree: string, parent: string, author: string, committer: string, message: string}
 */
export function parseCommit(commit) {
  // https://git-scm.com/book/en/v2/Git-Internals-Transfer-Protocols
  var b = true;
  if (commit.objectType != "commit" && commit.objectType != 1) throw new Error(`${commit.sha}is not a commit. (${commit.objectType})`)
  const commitdata = commit.data.toString("utf8").split("\n");
  let tree = commitdata[0].split(" ")[1];
  let parent = commitdata[1].split(" ")[1];
  let author = commitdata[2].split(" ")[1];
  let committer = commitdata[3].split(" ")[1];
  let message = commitdata.slice(4).join("\n");
  if (!commitdata[1].startsWith("parent")) {
    parent = undefined;
    tree = commitdata[0].split(" ")[1];
    author = commitdata[1].split(" ")[1];
    committer = commitdata[2].split(" ")[1];
    message = commitdata.slice(4).join("\n");
  }

  // const tree = commitdata[0].split(" ")[1];
  // const parent = commitdata[1].split(" ")[1];
  // const author = commitdata[2].split(" ")[1];
  // const committer = commitdata[3].split(" ")[1];
  // const message = commitdata.slice(4).join("\n");
  return { tree, parent, author, committer, message };
}
