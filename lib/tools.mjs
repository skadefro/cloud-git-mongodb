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
export let log_memory_usage = false;
export function setBatchSize(size) {
  batchSize = size;
}
export function setLogMemoryUsage(value) {
  log_memory_usage = value;
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
function isDate(variable) {
  return variable instanceof Date && !isNaN(variable);
}
function isNumber(variable) {
  if (typeof variable === 'number' && !isNaN(variable)) {
    const date = new Date(variable);
    return date instanceof Date && !isNaN(date);
  }
  return false;
}
function formatMilliseconds(milliseconds) {
  if (milliseconds < 1000) {
      return `${milliseconds.toFixed(0)} ms`;
  }

  const seconds = milliseconds / 1000;
  if (seconds < 60) {
      return `${seconds.toFixed(3)} s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = (seconds % 60).toFixed(3);
  return `${minutes}m ${remainingSeconds}s`;
}

const memoryUsage = process.memoryUsage();
let rss = memoryUsage.rss;
let heapTotal = memoryUsage.heapTotal;
let heapUsed = memoryUsage.heapUsed;
let external = memoryUsage.external;
let arrayBuffers = memoryUsage.arrayBuffers;
export const logMemoryUsage = (label, timelabel) => {
  if(log_memory_usage == false) return;
  // if (global.gc) {
  //   global.gc();
  // } else {
  //   console.warn("No GC hook! Start your program with `node --expose-gc file.js`.");
  // }
  const memoryUsage = process.memoryUsage();
  if(timelabel != null && isNumber(timelabel)) { // made with Date.now()
    const currentTime = Date.now();
    const time = currentTime - timelabel;    
    console.log(`Memory usage after ${label.padEnd(45)} RSS: ${formatBytes(memoryUsage.rss).padStart(10)} Heap Used: ${formatBytes(memoryUsage.heapUsed).padStart(10)} Heap Total: ${formatBytes(memoryUsage.heapTotal).padStart(10)} Time: ${formatMilliseconds(time)}`);
  } else if(timelabel != null && isDate(timelabel)) {
    const currentTime = new Date();
    const time = currentTime - timelabel;
    console.log(`Memory usage after ${label.padEnd(45)} RSS: ${formatBytes(memoryUsage.rss).padStart(10)} Heap Used: ${formatBytes(memoryUsage.heapUsed).padStart(10)} Heap Total: ${formatBytes(memoryUsage.heapTotal).padStart(10)} Time: ${formatMilliseconds(time)}`);
  } else if (timelabel != null && timelabel != "") {
    try {
      console.timeLog(timelabel, `${label.padEnd(45)} RSS: ${formatBytes(memoryUsage.rss).padStart(10)} Heap Used: ${formatBytes(memoryUsage.heapUsed).padStart(10)} Heap Total: ${formatBytes(memoryUsage.heapTotal).padStart(10)}`);
    } catch (error) {
      console.log(`Memory usage after ${label.padEnd(45)} RSS: ${formatBytes(memoryUsage.rss).padStart(10)} Heap Used: ${formatBytes(memoryUsage.heapUsed).padStart(10)} Heap Total: ${formatBytes(memoryUsage.heapTotal).padStart(10)}`);
    }
  } else {
    console.log(`Memory usage after ${label.padEnd(45)} RSS: ${formatBytes(memoryUsage.rss).padStart(10)} Heap Used: ${formatBytes(memoryUsage.heapUsed).padStart(10)} Heap Total: ${formatBytes(memoryUsage.heapTotal).padStart(10)}`);
  }
  // console.log(`RSS: ${formatBytes(memoryUsage.rss - rss)} now ${formatBytes(memoryUsage.rss)}`);
  // console.log(`Heap Total: ${formatBytes(memoryUsage.heapTotal - heapTotal)} now ${formatBytes(memoryUsage.heapTotal)}`);
  // console.log(`Heap Used: ${formatBytes(memoryUsage.heapUsed - heapUsed)} now ${formatBytes(memoryUsage.heapUsed)}`);
  // console.log(`External: ${formatBytes(memoryUsage.external - external)} now ${formatBytes(memoryUsage.external)}`);
  // console.log(`Array Buffers: ${formatBytes(memoryUsage.arrayBuffers - arrayBuffers)} now ${formatBytes(memoryUsage.arrayBuffers)}`);
  // console.log(`RSS: ${formatBytes(memoryUsage.rss)} Heap Used: ${formatBytes(memoryUsage.heapUsed)} Heap Total: ${formatBytes(memoryUsage.heapTotal)}`);
  rss = memoryUsage.rss;
  heapTotal = memoryUsage.heapTotal;
  heapUsed = memoryUsage.heapUsed;
  external = memoryUsage.external;
  arrayBuffers = memoryUsage.arrayBuffers;
  // fs.writeFileSync("memoryusage.txt", `Memory usage after ${label}:\nRSS: ${formatBytes(memoryUsage.rss)}\nHeap Total: ${formatBytes(memoryUsage.heapTotal)}\nHeap Used: ${formatBytes(memoryUsage.heapUsed)}\nExternal: ${formatBytes(memoryUsage.external)}\nArray Buffers: ${formatBytes(memoryUsage.arrayBuffers)}\n`, { flag: "a" });
};
export const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  if (bytes < 0) {
    bytes = bytes * -1;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return "-" + parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
  } else {
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
  }
}
export function getTimezoneOffsetInSeconds(timezone) {
  const sign = timezone[0] === '+' ? 1 : -1;
  const hours = parseInt(timezone.slice(1, 3));
  const minutes = parseInt(timezone.slice(3, 5));
  return sign * (hours * 3600 + minutes * 60);
}

export const modes = {
  // 100644: "blob", // normal file
  // 100755: "blob", // executable file
  // 120000: "blob", // symlink
  // 160000: "commit", // gitlink
  // 40000: "tree", // tree

  // 16384: "blob", // tree
  // 33188: "blob", // symlink

  33188: "blob", // file
  16384: "tree", // directory
  57344: "submodule", // submodule
};

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
  if (typeof data === 'string') {
    data = Buffer.from(data);
  }
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
    if (entry.name.length < 1) {
      throw new Error("Each entry must have a name.");
    }
    if (entry.sha.length !== 40) {
      throw new Error("Each entry must have a 40-character SHA.");
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
  if (tag.objectType != "tag" && tag.objectType != 4) throw new Error(`${tag.sha} is not a tag. (${tag.objectType})`)
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
  if (object.length != 40) throw new Error("Object SHA must be 40 characters.");

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
 * @returns {{tree: string, parents: string[], author: string, committer: string, message: string, date: date, committerdate: date, authordate: date}}
 */
export function parseCommit(commit) {
  // https://git-scm.com/book/en/v2/Git-Internals-Transfer-Protocols
  if(commit == null) {
    throw new Error("Commit is required.");
  }
  if (commit.objectType != "commit" && commit.objectType != 1) {
    throw new Error(`${commit.sha} is not a commit. (${commit.objectType})`);
  }
  if(commit.data == null) {
    throw new Error("Commit data is required.");
  }

  const commitData = commit.data.toString("utf8").split("\n");
  let tree = "";
  const parents = [];
  let author = "";
  let committer = "";
  let message = "";

  let authordate = null;
  let committerdate = null;
  for (let line of commitData) {
    if (line.startsWith("tree ")) {
      tree = line.split(" ")[1];
      if(tree.length !== 40) {
        confirm.log("tree", tree)
        throw new Error("Tree SHA must be 40 characters.");
      }
    } else if (line.startsWith("parent ")) {
      const parent = line.split(" ")[1];
      if(parent.length !== 40) {
        confirm.log("parent", parent)
        throw new Error("Parent SHA must be 40 characters.");
      }
      parents.push(parent);
    } else if (line.startsWith("author ")) {
      author = line.split(" ")[1];
      const parts = line.split(" ");
      const timestamp = parseInt(parts[parts.length - 2]);
      const timezone = parts[parts.length - 1];
      authordate = new Date((timestamp) * 1000);
      // authordate = new Date((timestamp + getTimezoneOffsetInSeconds(timezone)) * 1000);
    } else if (line.startsWith("committer ")) {
      committer = line.split(" ")[1];
      const parts = line.split(" ");
      const timestamp = parseInt(parts[parts.length - 2]);
      const timezone = parts[parts.length - 1];
      committerdate = new Date((timestamp) * 1000);
      // committerdate = new Date((timestamp + getTimezoneOffsetInSeconds(timezone)) * 1000);
    } else if (line.trim()) {
      // Remaining lines are part of the commit message
      message += line + "\n";
    }
  }
  let date = null;
  if(authordate != null) date = authordate;
  if(committerdate != null) date = committerdate;

  message = message.trim(); // Remove any trailing newline characters

  return { tree, parents, author, committer, message, date };
}
export function createCommit({ tree, parents, author, committer, message }) {
  // Validate inputs
  if (!tree) throw new Error("Tree hash is required.");
  if (!author) throw new Error("Author is required.");
  if (!committer) throw new Error("Committer is required.");
  if (!message) throw new Error("Commit message is required.");
  if(tree.length !== 40) {
    throw new Error("Tree SHA must be 40 characters.");
  }
  const currentTime = Math.floor(Date.now() / 1000) + " +0000";
  if (!/\d{10} \+\d{4}$/.test(author)) {
    author += " " + currentTime;
  }
  if (!/\d{10} \+\d{4}$/.test(committer)) {
    committer += " " + currentTime;
  }

  // Construct the commit data
  let commitData = `tree ${tree}\n`;
  if (parents) {
    if(Array.isArray(parents)) {
      for (const parent of parents) {
        if(parent.length !== 40) {
          throw new Error("Parent SHA must be 40 characters.");
        }
        commitData += `parent ${parent}\n`;
      }
    } else {
      if(parents.length !== 40) {
        throw new Error("parents SHA must be 40 characters.");
      }
      commitData += `parent ${parents}\n`;
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

