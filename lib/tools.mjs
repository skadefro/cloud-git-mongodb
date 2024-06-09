import inflate from 'pako/lib/inflate.js'
export const ZeroIdStr = "0".repeat(40);
export const Zero = Buffer.from([0]);
export const PackHeader = Buffer.from("PACK");
export const FlushPkt = Buffer.from("0000");

export const ZeroId = Buffer.from(ZeroIdStr);
export const LF = Buffer.from("\n");
export const DataBand = Buffer.from([1]);
export const ProgressBand = Buffer.from([2]);
export const ErrorBand = Buffer.from([3]);

export let batchSize = 200; // Adjust batch size as needed
export function setBatchSize(size) {
  batchSize = size;
}

let customDebugHandler = null;
export function setDebugHandler(handler) {
  customDebugHandler = handler;
}
export function debug(...args) {
  if (customDebugHandler) {
    customDebugHandler(...args);
  } else if (process.env.GIT_DEBUG != null && +process.env.GIT_DEBUG === 1) {
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
import { createHash } from 'crypto';
export function objectSha(object) {
  let header = Buffer.from(`${ObjectTypes[object.objectType]} ${object.data.length}\0`);
  let store = Buffer.concat([header, object.data]);
  return createHash('sha1').update(store).digest('hex');
}


/**
 * Parse a tree object and return the list of files and directories
 * @param {any} tree tree object (get it with getObject)
 * @returns {[{mode: number, name: string, sha: string}]}
 */
export function parseTree(tree) {
  if (tree.objectType != "tree" && tree.objectType != 2) throw new Error(`${tree.sha} is not a tree. (${tree.objectType})`)
  let treedata = tree.data;
  if (treedata[0] === 0x78 && treedata[1] === 0x9c) { // Check for zlib header
    treedata = inflate.inflate(treedata);
  }
  const entries = [];
  let offset = 0;
  while (offset < treedata.length) {
    let spaceIndex = treedata.indexOf(" ", offset);
    const mode = parseInt(treedata.toString("utf8", offset, spaceIndex), 8);
    if (isNaN(mode) || mode <= 0) {
      throw new Error(`Invalid mode in tree entry at offset ${offset}`);
    }
    offset = spaceIndex + 1;

    const nullIndex = treedata.indexOf("\0", offset);
    const filename = treedata.toString("utf8", offset, nullIndex);
    if (!filename || filename.trim() === "") {
      throw new Error(`Invalid filename in tree entry at offset ${offset}`);
    }
    offset = nullIndex + 1;

    const sha1 = treedata.slice(offset, offset + 20).toString("hex");
    if (sha1.length !== 40) {
      throw new Error(`Invalid SHA in tree entry at offset ${offset}`);
    }
    offset += 20;
    entries.push({ mode, name: filename, sha: sha1 });
  }
  return entries;
}
/**
* Create a tree object from the given list of files and directories
* @param {[{mode: number, name: string, sha: string}]} entries list of entries
* @returns {Buffer} tree object buffer
*/
export function createTree(entries) {
  // Validate inputs
  if (!Array.isArray(entries)) throw new Error("Entries must be an array.");
  for (const entry of entries) {
    if (typeof entry.mode !== 'number' || typeof entry.name !== 'string' || typeof entry.sha !== 'string') {
      throw new Error("Each entry must have a mode (number), name (string), and sha (string).");
    }
  }
  function compareStrings(a, b) {
    // https://stackoverflow.com/a/40355107/2168416
    return -(a < b) || +(a > b)
  }
  function compareTreeEntryPath(a, b) {
    return compareStrings(appendSlashIfDir(a), appendSlashIfDir(b))
  }
  function appendSlashIfDir(entry) {
    // According to http://git.661346.n2.nabble.com/In-tree-object-Must-the-tp7446900p7447657.html
    // The entries in the tree are alpha-sorted. The exception are trees, where you have to pretend that there is a trailing slash.
    return (entry.mode === '040000'.toString(8) || entry.mode === 16384) ? entry.name + '/' : entry.name
  }
  entries.sort(compareTreeEntryPath)

  // Construct the tree data
  let treeData = '';
  for (const entry of entries) {
    treeData += `${entry.mode.toString(8)} ${entry.name}\0`;
    treeData += Buffer.from(entry.sha, 'hex').toString('binary');
  }
  const data = Buffer.from(treeData, 'binary');
  // Convert tree data to Buffer
  const result = {
    objectType: 2, // 'tree',
    data,
    sha: ""
  };
  result.sha = objectSha(result)
  return result
}

/**
 * Parse a tag object and return the object, type, tagger and message
 * @param {any} tag tag object (get it with getObject)
 * @returns {{object: string, type: string, tagger: string, message: string}}
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
 * Create a tag object from the given parameters
 * @param {string} object SHA-1 of the tagged object
 * @param {string} type type of the tagged object (e.g., "commit", "tree", etc.)
 * @param {string} tagger tagger information
 * @param {string} message tag message
 * @returns {Buffer} tag object buffer
 */
export function createTag({ object, type, tag, tagger, message }) {
  // Validate inputs
  if (!object) throw new Error("Object SHA is required.");
  if (!type) throw new Error("Object type is required.");
  if (!tagger) throw new Error("Tagger information is required.");
  if (!message) throw new Error("Tag message is required.");

  // Construct the tag data
  let tagData = `object ${object}\n`;
  tagData += `type ${type}\n`;
  tagData += `tag ${tag}\n`;
  tagData += `tagger ${tagger}\n`;
  tagData += `\n${message}\n`;

  const data = Buffer.from(tagData, 'utf8');
  const result = {
    objectType: 4, // 'tag',
    data,
    sha: ""
  };
  result.sha = objectSha(result)
  return result

}
/**
 * Parse a commit object and return the tree, parent, author, committer and message
 * @param {any} commit commit object (get it with getObject) 
 * @returns {{tree: string, parents: string[], author: string, committer: string, message: string}}
 */
export function parseCommit(commit) {
  // https://git-scm.com/book/en/v2/Git-Internals-Transfer-Protocols
  if (commit.objectType != "commit" && commit.objectType != 1) {
    throw new Error(`${commit.sha} is not a commit. (${commit.objectType})`);
  }

  const commitData = commit.data.toString("utf8").split("\n");
  let tree = "";
  const parents = [];
  let author = "";
  let committer = "";
  let message = "";

  for (let line of commitData) {
    if (line.startsWith("tree ")) {
      tree = line.split(" ")[1];
    } else if (line.startsWith("parent ")) {
      parents.push(line.split(" ")[1]);
    } else if (line.startsWith("author ")) {
      author = line.split(" ")[1];
    } else if (line.startsWith("committer ")) {
      committer = line.split(" ")[1];
    } else if (line.trim()) {
      // Remaining lines are part of the commit message
      message += line + "\n";
    }
  }

  message = message.trim(); // Remove any trailing newline characters

  return {tree, parents, author, committer, message };
}
export function createCommit({ tree, parents, author, committer, message }) {
  // Validate inputs
  if (!tree) throw new Error("Tree hash is required.");
  if (!author) throw new Error("Author is required.");
  if (!committer) throw new Error("Committer is required.");
  if (!message) throw new Error("Commit message is required.");

  // Construct the commit data
  let commitData = `tree ${tree}\n`;
  if (parents) {
    if(Array.isArray(parents)) {
      for (const parent of parents) {
        commitData += `parent ${parent}\n`;
      }
    } else {
      commitData += `parent ${parent}\n`;
    }    
  }
  commitData += `author ${author}\n`;
  commitData += `committer ${committer}\n\n${message}\n`;

  const data = Buffer.from(commitData, 'utf8');

  const result = {
    objectType: 1, // 'commit',
    data,
    sha: ""
  };
  result.sha = objectSha(result)
  return result
}

