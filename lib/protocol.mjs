// @ts-check
import { ObjectId } from "mongodb";
import { createHash } from 'crypto';
import * as zlib from 'zlib';
import { Transform } from "stream";
import { tools } from './index.mjs';
const SupportedCapabilities = "side-band-64k delete-refs report-status filter allow-reachable-sha1-in-want"; // skip "shallow" for now
const supportedServices = ["git-receive-pack", "git-upload-pack"];

function enqueue(closure, queue, sha) {
  if (sha.length !== 40) {
    throw new Error(`Resolving dependency tree resulted in a sha "${sha}" which is not 40 characters long.`);
  }
  if (!closure[sha]) {
    queue.push(sha);
  }
}

async function processCommit(req, state, closure, queue, object) {
  if (object.parents != null || object.tree != null) {
    tools.debug("commit", object.tree);
    enqueue(closure, queue, object.tree);
    if (object.parents && object.parents.length > 0) {
      object.parents.forEach(parent => enqueue(closure, queue, parent));
    } else if (object.tree == null || object.tree == "") {
      throw new Error("Invalid commit object. Missing tree and parent references.");
    }
  } else if (!object.data) {
    await state.repository.getObjectData(object);
    const commit = tools.parseCommit(object);
    tools.debug("commit", commit.tree);
    enqueue(closure, queue, commit.tree);
    if (commit.parents && commit.parents.length > 0) {
      commit.parents.forEach(parent => enqueue(closure, queue, parent));
    }
  }
}

async function processTag(req, state, closure, queue, object) {
  if (object.tree != null) {
    tools.debug("commit", object.tree);
    enqueue(closure, queue, object.tree);
    return;
  }
  if (!object.data) {
    await state.repository.getObjectData(object);
  }
  const tag = tools.parseTag(object);
  enqueue(closure, queue, tag.object);
}

async function processTree(req, state, closure, queue, object) {
  if (object.entries) {
    object.entries.forEach(item => enqueue(closure, queue, item.sha));
    return;
  }
  if (!object.data) {
    await state.repository.getObjectData(object);
  }
  const tree = await tools.parseTree(object);
  tree.forEach(item => enqueue(closure, queue, item.sha));
}

async function computeClosure(req, state, closure, queue) {
  while (queue.length > 0) {
    const batch = queue.splice(0, tools.batchSize);

    await Promise.all(batch.map(async sha => {
      return new Promise(async (resolve, reject) => {
        let object = closure[sha];
        if (!object) {
          try {
            object = await state.repository.getObjectMeta(sha);
            closure[sha] = object;
          } catch (error) {
            console.error(`Error getting object ${sha}: ${error.message}`);
            return resolve(object);
          }
        }

        if (object.objectType === "commit" || object.objectType === 1) {
          await processCommit(req, state, closure, queue, object);
        } else if (object.objectType === "tree" || object.objectType === 2) {
          await processTree(req, state, closure, queue, object);
        } else if (object.objectType === "tag" || object.objectType === 4) {
          await processTag(req, state, closure, queue, object);
        }
        resolve(object);
      });
    }));
    tools.logMemoryUsage(`computed ${Object.keys(closure).length} objects ${queue.length} in queue`);
  }
}

async function getUploadPack(req, state) {
  const closure = {};
  const queue = state.commands.filter(x => x.command === "want").map(x => x.sha);

  await computeClosure(req, state, closure, queue);

  tools.debug("CLOSURE", Object.keys(closure).length, "objects");
  return Object.keys(closure).map(sha => closure[sha]);
}

async function sendWantedObjects(req, res, state) {
  try {
    const starttime = Date.now();
    tools.logMemoryUsage("begin", starttime);


    let wants = state.commands.filter(x => x.command === "want").map(x => x.sha);
    let haves = state.commands.filter(x => x.command === "have").map(x => x.sha);
    let shas = state.commands.filter(x => x.command === "want").map(x => x.sha);
    let commits = 0;
    let trees = 0;
    let tags = 0;
    let blobs = 0;

    if (state.repository.getUploadPack != null && state.repository.collection != null) {
      if (haves.length == 0 && (state.filters == null || state.filters.length == 0)) {
        tools.debug(`${wants.length} wanted shas`);
        res.write(toPktLine("NAK\n"));
        // shas = await state.repository.collection.distinct("sha", {});
        shas = await state.repository.getUploadPack(wants, haves, state.filters);
      } else {
        const havecount = haves.length;
        tools.debug(`Traverse ${haves.length} has shas`);
        if(haves.length > 0) {
          haves = await state.repository.getUploadPack(haves, null, state.filters);
        }
        if(state.isShallow) {
          state.filters = ["blob:none", "tree:none"]
        }
        tools.debug(`Traverse ${wants.length} wanted shas`);
        shas = await state.repository.getUploadPack(wants, haves, state.filters);

        if(state.isShallow) {
          // res.write(toPktLine(`ACK ${shas[0]}\n`));
          // res.write(tools.FlushPkt);
          // res.write(toPktLine("shallow-info\n"));
          for(let i = 0; i < shas.length; i++) {
            res.write(toPktLine(`shallow ${shas[i]}\n`));
          }
          // res.write(toPktLine(`unshallow 4cbe298b35bf93d9cd62faf76b015bd6410bbf02\n`));
          res.write(tools.FlushPkt); // if i send this i get `fatal: git fetch-pack: expected shallow list` in the git client
          // if i skip FlushPkt, i get `fatal: expected shallow/unshallow, got ?PACK`
          // res.write(toPktLine("NAK\n"));
        } else if(haves.length == 0) {
          res.write(toPktLine("NAK\n"));
        } else {
          res.write(toPktLine(`ACK ${haves[haves.length - 1]}\n`));
        }

        tools.debug(`Found ${shas.length} shas and ${haves.length} haves (from ${havecount} haves)`);
        // shas = await state.repository.collection.distinct("sha", {});
        // res.write(toPktLine(`ACK ${haves[haves.length - 1]}\n`));
        // haves = [];
      }
      tools.debug(`sending ${shas.length} shas`);
    }
    if (state.repository.getUploadPack != null && state.repository.collection != null) {
      tools.logMemoryUsage(("upload-pack " + shas.length + " objects"), starttime);
      const sha1 = createHash("sha1");


      // PACK header
      const packHeader = Buffer.from("PACK        "); // 12 bytes
      packHeader.writeUInt32BE(2, 4); // version
      packHeader.writeUInt32BE(shas.length, 8); // number of objects in the packfile
      res.write(toPktLinesWithBand(tools.DataBand, packHeader));
      sha1.update(packHeader);

      const sub_sub_starttime = Date.now();
      let objectCount = 0;
      // if shas.length does not match the number of objects send, git cli reports "fatal: final sha1 did not match" and "fatal: unpack-objects failed"
      let query = { sha: { $in: shas } };
      if (shas.length > 1000) {
        // @ts-ignore
        query = {};
      }
      const cursor = state.repository.collection.find(query);
      for await (const object of cursor) {
        if (shas.indexOf(object.sha) == -1) { continue; }
        if (!object.data) {
          // tools.logMemoryUsage((`pre  download of ${object.size}b object`), sub_sub_starttime);
          // await state.repository.getObjectData(object);
          // tools.logMemoryUsage((`post download of ${object.size}b object`), sub_sub_starttime);
          // const msperobject = (Date.now() - sub_sub_starttime) / objectCount;
        } else if (object.data?.buffer != null) {
          object.data = object.data.buffer;
        }

        let length = object.size;
        let type = object.objecttype;
        if (typeof type === "string") {
          type = tools.ObjectNames[object.objecttype];
        }
        if(type == 1) commits++;
        if(type == 2) trees++;
        if(type == 3) blobs++;
        if(type == 4) tags++;
        // if(type == 1) console.log("commit", object.sha);
    
        let firstByte = (type << 4) | (length & 0b00001111);
        length >>= 4;
        firstByte |= (length > 0 ? 0b10000000 : 0);
        let header = [firstByte];
        while (length > 0) {
          let nextByte = length & 0b01111111;
          length >>= 7;
          nextByte |= (length > 0 ? 0b10000000 : 0);
          header.push(nextByte);
        }
        if (object.data != null) {
          const expectedsha = object.sha;
          let data = object.data;
          if (object.zlib === false) {
            const actuallysha = objectSha(data, type);
            if (expectedsha != actuallysha) {
              console.error(`sha mismatch ${expectedsha} != ${actuallysha}`);
              throw new Error(`sha mismatch ${expectedsha} != ${actuallysha}`);
            }
            data = zlib.deflateSync(data);
          } else {
            const uncompressed = zlib.inflateSync(data);
            const actuallysha = objectSha(uncompressed, type);
            if (expectedsha != actuallysha) {
              console.error(`sha mismatch ${expectedsha} != ${actuallysha}`);
              throw new Error(`sha mismatch ${expectedsha} != ${actuallysha}`);
            }
          }

          const newheader = Buffer.from(header);
          res.write(toPktLinesWithBand(tools.DataBand, newheader, data));
          sha1.update(newheader).update(data);
        } else {
          const downloadStream = state.repository.bucket.openDownloadStream(new ObjectId(object.fileid));
          const newheader = Buffer.from(header);

          res.write(toPktLinesWithBand(tools.DataBand, newheader));
          sha1.update(newheader);

          if (object.zlib === false) {
            const deflate = zlib.createDeflate();
            await new Promise((resolve, reject) => {
              downloadStream
                .pipe(deflate)
                .on('data', (chunk) => {
                  res.write(toPktLinesWithBand(tools.DataBand, chunk));
                  sha1.update(chunk);
                })
                .on('end', resolve)
                .on('error', reject);
            });
          } else {


            await new Promise((resolve, reject) => {
              downloadStream
                .on('data', (chunk) => {
                  res.write(toPktLinesWithBand(tools.DataBand, chunk));
                  sha1.update(chunk);
                })
                .on('end', resolve)
                .on('error', reject);
            });
          }
        }





        objectCount++;
        if (objectCount % 5000 === 0) {
          const msperobject = (Date.now() - sub_sub_starttime) / objectCount;
          tools.logMemoryUsage((`sent ${objectCount} objects (${msperobject.toFixed(2)}ms per object)`), sub_sub_starttime);
        }
        // is client connect ?
        if (res.socket.destroyed) {
          tools.debug("client disconnected");
          return;
        }
      }

      res.write(toPktLinesWithBand(tools.DataBand, sha1.digest()));

      const message = await state.repository.getUploadPackSuccessMessage(req, shas);
      if (message) {
        res.write(toPktLinesWithBand(tools.ProgressBand, message));
      }
      res.write(tools.FlushPkt);

      tools.debug("commits", commits, "trees", trees, "blobs", blobs, "tags", tags);
      return;
    }

    let objects = await getUploadPack(req, state);
    tools.logMemoryUsage(`sendWantedObjects upload-pack ${objects.length} objects`, starttime);
    const sha1 = createHash("sha1");

    // PACK header
    const packHeader = Buffer.from("PACK        "); // 12 bytes
    packHeader.writeUInt32BE(2, 4); // version
    packHeader.writeUInt32BE(objects.length, 8); // number of objects in the packfile
    res.write(toPktLinesWithBand(tools.DataBand, packHeader));
    sha1.update(packHeader);

    const sub_starttime = Date.now();
    let objectCount = 0;
    // Fetch and write object data in smaller batches
    while (objects.length > 0) {
      const batch = objects.splice(0, tools.batchSize);

      await Promise.all(batch.map(async object => {
        if (!object.data) {
          tools.debug("download ", object.sha);
          await state.repository.getObjectData(object);
        }

        let length = object.size;
        let type = object.objectType;
        if (typeof type === "string") {
          type = tools.ObjectNames[object.objectType];
        }
        if(type == 1) commits++;
        if(type == 2) trees++;
        if(type == 3) blobs++;
        if(type == 4) tags++;

        let firstByte = (type << 4) | (length & 0b00001111);
        length >>= 4;
        firstByte |= (length > 0 ? 0b10000000 : 0);
        let header = [firstByte];
        while (length > 0) {
          let nextByte = length & 0b01111111;
          length >>= 7;
          nextByte |= (length > 0 ? 0b10000000 : 0);
          header.push(nextByte);
        }
        const data = zlib.deflateSync(object.data);
        const newheader = Buffer.from(header);
        res.write(toPktLinesWithBand(tools.DataBand, newheader, data));
        sha1.update(newheader).update(data);
        objectCount++;
        if (objectCount % 1000 === 0 && objectCount > 0) {
          const msperobject = (Date.now() - sub_starttime) / objectCount;
          tools.logMemoryUsage(`sent ${objectCount} objects (${msperobject.toFixed(2)}ms per object)`, sub_starttime);
        }
      }));
    }

    res.write(toPktLinesWithBand(tools.DataBand, sha1.digest()));

    const message = await state.repository.getUploadPackSuccessMessage(req, objects);
    if (message) {
      res.write(toPktLinesWithBand(tools.ProgressBand, message));
    }
    res.write(tools.FlushPkt);
    tools.debug("commits", commits, "trees", trees, "blobs", blobs, "tags", tags);
  } catch (error) {
    console.error("!!!!!!!!!!!!! Error sending wanted objects !!!!!!!!!!!!!!!!!!! :", error.message);

  } finally {
    tools.logMemoryUsage("complete");
  }
}

async function inflate(buf, options) {
  return new Promise((resolve, reject) => {
    zlib.inflate(buf, options, (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}

async function readObject(state) {
  const bufferlength = state.bufferLength - state.start;
  if (bufferlength < 1) return false; // Not enough data in buffer to start parsing type and length of an object
  let byte = state.buffer[state.start];
  // Parse object length and type. First byte is special.
  let moreBytes = !!(byte & 0b10000000); // Bit 8 is 1 if subsequent bytes are part of the size
  let objectType = (byte & 0b01110000) >> 4; // Bits 5-7 encode the object type
  let length = byte & 0b00001111; // Bits 1-4 encode the size
  if (!{ 1: 1, 2: 1, 3: 1, 4: 1, 7: 1 }[objectType]) {
    // we try handling that using commandRequiresPackfile before we get here. Not sure what is best yet.
    if (objectType === 0) {
      // when git is sending lightweight tag, or new branch with no commits, it sends a 0 object type
      // According to https://git-scm.com/docs/pack-format that is not a valid object type!!!!
      // So we discard it and continue if we did also received a command ( most likely this command will then contain a ref with srcId as ZeroIdStr )
      if (state.commands.length > 0) {
        state.stage = tools.Stages.PackChecksum;
        return false;
      }
      tools.debug("Received objectType 0, which is unexpected. Skipping processing for this object.");
    }
    throw new Error(
      `Protocol error. Server only supports pack object types 1-4 and 7, but client sent ${objectType}.`
    );
  }
  // Subsequent bytes contain length information until the most significat bit becomes 0.
  let bufferOffset = 1;
  let bitOffset = 4;
  while (moreBytes) {
    if (bufferOffset >= bufferlength) {
      return false; // Not enough data in buffer to continue
    }
    moreBytes = !!(state.buffer[state.start + bufferOffset] & 0b10000000); // Bit 8 is 1 if subsequent bytes are part of the size
    length += (state.buffer[state.start + bufferOffset] & 0b01111111) << bitOffset; // Bits 1-7 contain length
    bitOffset += 7;
    bufferOffset++;
  }
  if (length > bufferlength) { // We need to wait for more data to arrive
    if (state.lastbufferLength != bufferlength) { // unless we dont, then just try anyway
      state.lastbufferLength = bufferlength;
      state.skipcounter++;
      // tools.debug(`readObjectHeader: Not enough data in buffer to read object of type ${objectType} and length ${tools.formatBytes(length)}, buffer has ${tools.formatBytes(bufferlength)}`);
      return false;
    }
    // this seems stupid, but . This way we ensure the client have had at least 2 tries at sending the needed data, to avoid wasting time
    // on zlib trying to find the size of the compress file, when it is not fully there.
  }
  delete state.lastbufferLength;

  // tools.debug(`readObjectHeader: #${state.packObjectsLeft} objects left. initial byte: ${byte.toString(16)}, type (4 bits): ${objectType}, length (4 bits): ${length} has ${state.buffer.length}, bufferOffset: ${bufferOffset}`);
  // Deltified representation starts with the identifier of the base object; resolve base object
  let baseObject;
  if (objectType === 7) {
    // obj_ref_delta
    if (bufferOffset + 20 >= bufferlength) {
      return false; // Not enough data in buffer to continue
    }
    const baseSha = state.buffer.subarray(state.start + bufferOffset, state.start + bufferOffset + 20).toString("hex");
    // tools.debug("Get baseObject with sha", baseSha);
    if (baseSha == null || baseSha.trim() == "") {
      tools.debug("baseSha is null or empty");
      throw new Error("baseSha is null or empty");
    }
    bufferOffset += 20;
    // baseObject = state.objects[baseSha];
    if (!baseObject) {
      // if using file cache we do not need to await, since the object we are looking for will been on disk (happens before promise is resolved)
      // if not using file cache, we need to await, since the object we are looking for might be in the promises array
      if(state.repository.usefilecache == null || state.repository.usefilecache == false) {
        await Promise.all(state.promises);
        state.promises = [];
      }
      baseObject = await state.repository.getObject(undefined, baseSha);
    }
    if (!baseObject) {
      throw new Error(`Protocol error. Base object ${baseSha} of a deltified object is not present in the pack.`);
    }
  }
  // Inflate compressed object data; 
  let data;
  let compressedbuffer = state.buffer.subarray(state.start + bufferOffset);
  try {
    const options = {
      info: true // Allows us to find out the number of bytes that were in the compressed representation
    };
    // if (length > 0) {
    //   // @ts-ignore
    //   options.maxOutputLength = length;
    // }
    // data = zlib.inflateSync(compressedbuffer, options);
    data = await inflate(compressedbuffer, options);
    if (state.lastdata != null) {
      // console.log("lastdata", state.lastdata.toString('hex', 0, 50));
      // console.log("current ", compressedbuffer.subarray(0, 50).toString('hex', 0, 50));
      // console.log("lastlength", tools.formatBytes(state.lastlength), "current", tools.formatBytes(length));
      console.log("lastbuffersize", tools.formatBytes(state.lastbuffersize), "current", tools.formatBytes(bufferlength));
      state.lastdata = null;
      state.lastlength = null;
      state.lastdata = null;
      state.lastbuffersize = null;
    }
  } catch (e) {
    state.lastlength = length;
    state.lastdata = compressedbuffer.subarray(0, 50);
    state.lastbuffersize = bufferlength;
    console.log("Error inflating object", e.code, "uncompressed size", tools.formatBytes(length), "buffer size", tools.formatBytes(state.lastbuffersize), " (", length, "/", state.lastbuffersize, ")");
    if (e.code === "Z_BUF_ERROR") {
      return false; // Not enought data in buffer to inflate the compressed object
    }
    return false;
    // throw e;
  }
  // Undeltify the object
  if (objectType === 7) {
    // @ts-ignore
    data.buffer = undeltify(baseObject.data, data.buffer);
    objectType = baseObject.objectType;
    if (typeof objectType === "string") {
      objectType = tools.ObjectNames[objectType];
    }
  }
  // @ts-ignore
  // tools.debug(`slice buffer: bufferOffset: ${bufferOffset}, bytesWritten: ${data.engine.bytesWritten}`);
  // @ts-ignore
  // state.buffer = state.buffer.slice(state.start + bufferOffset + data.engine.bytesWritten); // The .bytesWritten contains the number of bytes of the compressed represenation consumed from the buffer
  state.start += bufferOffset + data.engine.bytesWritten;
  trimBuffer(state);
  let sha1 = objectSha(data.buffer, objectType)
  // state.objects[sha1] = { objectType, data: data.buffer, sha: sha1 };
  state.promises.push(state.repository.storeObject({ objectType, data: data.buffer, sha: sha1 }));
  // state.repository.storeObject({ objectType, data: data.buffer, sha: sha1 });
  if (state.promises.length > 100) {
    await Promise.all(state.promises);
    state.promises = [];
  }
  if (state.packObjectsLeft % 100 == 0) {
    tools.logMemoryUsage(`readObject: Received ${tools.ObjectTypes[objectType]} object ${state.packObjectsLeft}/${state.numObjects}, skipcounter: ${state.skipcounter}`);
  }
  state.packObjectsLeft--;
  if (state.packObjectsLeft === 0) {
    state.stage = tools.Stages.PackChecksum;
  }
  return true; // Continue parsing subsequent objects

}

/**
 * Serialize a list of strings and buffers to a pkt-line
 * @param {any} args 
 * @param {number} start 
 * @returns {[Buffer[], number]} 
 */
function collectBuffers(args, start) {
  let length = 0;
  const list = [];
  for (var k = start; k < args.length; k++) {
    let buffer = args[k];
    if (typeof buffer === "string") {
      buffer = Buffer.from(buffer);
    } else if (!Buffer.isBuffer(buffer)) {
      throw new Error("Only strings and buffers can be serialized to pkt-line");
    }
    length += buffer.length;
    list.push(buffer);
  }
  return [list, length];
}
function toPktLinesWithBand(band, ...args) {
  let [list, length] = collectBuffers(arguments, 1);
  let buffer = Buffer.concat(list);
  let offset = 0;
  let lines = [];
  while (offset < buffer.length) {
    let subbuf = buffer.subarray(offset, offset + 999);
    let length = subbuf.length + 5;
    lines.push(Buffer.from(length.toString(16).padStart(4, "0"))); // pkt-line length
    lines.push(band); // Band id
    lines.push(subbuf); // Up to 999 bytes of payload
    offset += subbuf.length;
  }
  return Buffer.concat(lines);
}
function toPktLine(...args) {
  let [list, length] = collectBuffers(arguments, 0);
  length += 4;
  list.unshift(Buffer.from(length.toString(16).padStart(4, "0")));
  return Buffer.concat(list);
}

function readPktLine(state) {
  let bufferlength = state.bufferLength - state.start;
  if (bufferlength == 0) {
    // PackData: no / PackHeader: no / PackChecksum: no / Final: fatal: git fetch-pack: expected ACK/NAK, got '?PACK'
    state.stage = tools.Stages.Final;
    return null;
  }
  if (bufferlength < 4) {
    throw new Error('Incomplete packet length header');
  }
  const lengthHex = state.buffer.toString('utf8', state.start, state.start + 4);
  const length = parseInt(lengthHex, 16);
  if (isNaN(length)) {
    throw new Error(`Invalid packet length: ${lengthHex}`);
  }
  // Detect the '0000' flush packet
  if (length === 0) {
    tools.debug('Detected flush packet (0000)');
    state.start += 4; // Move past this packet's length header
    if (state.service == "git-receive-pack") {
      state.stage = tools.Stages.PackHeader;
    } else {
      // next we should get 0009done\n and then 0008NAK\n ??
    }
    return null; // Indicate a flush packet was found, or handle as needed
  }
  bufferlength = state.bufferLength - state.start;
  if (bufferlength < length) {
    return null; // throw new Error('Incomplete packet line');    
  }
  let line = state.buffer.toString('utf8', state.start + 4, state.start + length);
  // tools.debug(`readPktLine: length: ${length}, line: ${line.split('\n').join(" ")}`);

  if (state.commands.length === 0) {
    [line, state.requestedCapabilities] = line.split("\x00");
    if (state.requestedCapabilities != null) {
      state.requestedCapabilities = state.requestedCapabilities.trim().split(" ");
    }
  }
  if (state.service == "git-receive-pack") {
    let srcId, destId, ref;
    if (state.requestedCapabilities) {
      [srcId, destId, ref] = line.split(" ");
    } else {
      // Technically this is protocol violation, but this is what the git CLI does
      [srcId, destId, ref, state.requestedCapabilities] = line.split(" ");
      if (state.requestedCapabilities != null) {
        state.requestedCapabilities = state.requestedCapabilities.trim().split(" ");
      }
    }
    let command = "unknown"; // https://git-scm.com/docs/pack-protocol#_reference_update_request_and_packfile_transfer
    if (tools.isZeroId(srcId) && !tools.isZeroId(destId)) {
      command = "create";
    } else if (!tools.isZeroId(srcId) && !tools.isZeroId(destId)) {
      command = "update";
    } else if (!tools.isZeroId(srcId) && tools.isZeroId(destId)) {
      command = "delete";
    }
    if (command === "unknown") {
      throw new Error(`Protocol error. Unknown command: ${line}`);
    }
    state.commands.push({ command, srcId, destId, ref });
  } else if (state.service == "git-upload-pack") {
    let command, sha;
    if (state.requestedCapabilities) {
      [command, sha] = line.split(" ");
    } else {
      // Technically this is protocol violation, but this is what the git CLI does
      [command, sha, state.requestedCapabilities] = line.split(" ");
    }
    if (sha != null) sha = sha.split("\n").join("").trim();
    if (command === "want" || command === "have") {
      let wants = state.commands.filter(c => c.command === "want");
      if (command === "have" && wants.length === 0) {
        throw new Error(`Protocol error. Client sent "have" command without sending any "want" commands.`);
      }
      if (state.commands.find(c => c.command === "want" && c.sha === sha) == null) {
        state.commands.push({ command, sha });
      }
    } else if (command === "filter") {
      state.filters = sha.split("combine:").join("").split("+");
      for(var i = 0; i < state.filters.length; i++) {
        const f = state.filters[i];
        if(f.indexOf(":") == 0) throw new Error(`Protocol error. Invalid filter: ${f}`);
        if(f.split(":")[0] != "blob" && f.split(":")[0] != "tree") throw new Error(`Protocol error. Unsupported filter: ${f} (only blob is supported)`);
      }
    } else if (command === "deepen") {
      state.filters = sha.split(" ");
      state.isShallow = true;
      state.depth = parseInt(line.split(' ')[1], 10);
    } else if (command.startsWith("done")) {
      state.stage = tools.Stages.Final;
    } else {
      throw new Error(`Protocol error. Unknown command: ${line}`);
    }
  } else {
    throw new Error(`Protocol error. Unknown service: ${state.service}`);
  }


  state.start += length;
  trimBuffer(state);
  return line;
}
function trimBuffer(state) {
  if (state.start === 0) return;
  if (state.start === state.bufferLength) {
    // If all data has been processed, just reset the indices to reuse the buffer
    state.bufferLength = 0;
    state.start = 0;
    return;
  }
  const mb = 1 * 1024 * 1024;
  // with 1mb buffer, we should not have to trim the buffer, but we do it anyway
  // Memory usage after readObject: Received tree object 100/20749, skipcounter: 1866 RSS:  334.51 MB Heap Used:    21.3 MB Heap Total:    59.9 MB
  if (state.start < mb) return;
  // console.log("****************** trimBuffer ******************");
  // Copy the unprocessed part of the buffer back to the beginning

  // Memory usage after readObject: Received tree object 100/20749, skipcounter: 1866 RSS:  339.12 MB Heap Used:   21.52 MB Heap Total:   59.65 MB
  const remainingLength = state.bufferLength - state.start;
  state.buffer.copy(state.buffer, 0, state.start, state.bufferLength);
  state.bufferLength = remainingLength;
  state.start = 0;
}

function readPackHeader(state) {
  // Ensure we're at the start of the packfile
  const signature = state.buffer.toString('utf8', state.start, state.start + 4);
  if (signature !== 'PACK') {
    if (signature == '') {
      state.stage = tools.Stages.Final;
      return
    }
    throw new Error('Invalid packfile signature');
  }
  state.start += 4; // Move past "PACK"

  const version = state.buffer.readUInt32BE(state.start);
  const numObjects = state.buffer.readUInt32BE(state.start + 4);

  state.version = version;
  state.numObjects = numObjects;
  state.packObjectsLeft = numObjects;
  tools.debug(`Packfile version: ${version}, number of objects: ${numObjects}`);
  state.stage = tools.Stages.PackData;

  state.start += 8; // Move past version and object count to the first object
  trimBuffer(state);
}


function parseVarint(ctx) {
  let v = 0;
  let moreBytes = true;
  let shift = 0;
  do {
    if (ctx.offset >= ctx.buffer.length) {
      throw new Error("Protocol error. Not enough data sent by the client to parse a variable length integer.");
    }
    moreBytes = !!(ctx.buffer[ctx.offset] & 0b10000000);
    v += (ctx.buffer[ctx.offset] & 0b01111111) << shift;
    shift += 7;
    ctx.offset++;
  } while (moreBytes);
  return v;
}
function parseDeltaInstruction(ctx) {
  if (ctx.buffer[ctx.offset] === 0) {
    throw new Error("Protocol error. Deltified instruction starts with a byte with value of 0.");
  }
  let isCopy = !!(ctx.buffer[ctx.offset] & 0b10000000);
  if (isCopy) {
    let suboffset = 1;
    let start = 0;
    [0b00000001, 0b00000010, 0b00000100, 0b00001000].forEach(
      (mask, i) => (start += ctx.buffer[ctx.offset] & mask ? ctx.buffer[ctx.offset + suboffset++] << (8 * i) : 0)
    );
    let size = 0;
    [0b00010000, 0b00100000, 0b01000000].forEach(
      (mask, i) => (size += ctx.buffer[ctx.offset] & mask ? ctx.buffer[ctx.offset + suboffset++] << (8 * i) : 0)
    );
    if (ctx.offset + suboffset > ctx.buffer.length) {
      throw new Error("Protocol error. Not enough data in buffer to parse a deltified copy instruction.");
    }
    if (size === 0) {
      size = 0x10000;
    }
    ctx.offset += suboffset;
    return { copy: { start, size } };
  } else {
    // insert
    return { insert: ctx.buffer[ctx.offset++] };
  }
}
function undeltify(srcBuffer, deltaBuffer) {
  const delta = { offset: 0, buffer: deltaBuffer };
  const srcLength = parseVarint(delta);
  if (!Buffer.isBuffer(srcBuffer)) {
    srcBuffer = Buffer.from(srcBuffer);
  }
  if (srcLength !== srcBuffer.length) {
    throw new Error(
      `Protocol error. The source length in the deltified object is ${srcLength} and does not match the base object"s length of ${srcBuffer.length}.`
    );
  }
  const destLength = parseVarint(delta);
  const result = Buffer.alloc(destLength);
  let resultOffset = 0;
  while (delta.offset < delta.buffer.length) {
    const instruction = parseDeltaInstruction(delta);
    if (instruction.insert) {
      if (delta.offset + instruction.insert > delta.buffer.length) {
        throw new Error("Protocol error. The deltified insert does not contain sufficient data.");
      }
      delta.buffer.copy(result, resultOffset, delta.offset, delta.offset + instruction.insert);
      resultOffset += instruction.insert;
      delta.offset += instruction.insert;
    } else {
      // copy
      if (instruction.copy == null || instruction.copy.start + instruction.copy.size > srcBuffer.length) {
        throw new Error("Protocol error. The deltified copy instruction is outside of the source object.");
      }
      srcBuffer.copy(result, resultOffset, instruction.copy.start, instruction.copy.start + instruction.copy.size);
      resultOffset += instruction.copy.size;
    }
  }
  if (resultOffset !== result.length) {
    throw new Error("Protocol error. Undeltified object is incomplete.");
  }
  // tools.debug("UNDELTIFIED", { srcLength, destLength });
  return result;
}

function objectSha(data, type) {
  if (typeof data === 'string') {
    data = Buffer.from(data);
  }
  let header = Buffer.from(`${tools.ObjectTypes[type]} ${data.length}\0`);
  let store = Buffer.concat([header, data]);
  return createHash('sha1').update(store).digest('hex');
}

function parsePackChecksum(state) {
  const bufferlength = state.bufferLength - state.start;
  if (bufferlength < 20) return false; // Not enough data in buffer;
  if (bufferlength !== 20) {
    throw new Error(`Protocol error. Expected a 20 byte checksum at the end of the pack data, but remaining data is ${bufferlength} long.`);
  } else {
    state.stage = tools.Stages.Final;
    state.start += 20;
    trimBuffer(state);
  }
  return false;
}

export async function handleGetRefs(repository, req, res, next) {
  try {
    if (!req.query.service) {
      return res.status(403).json({
        status: 403,
        message: "The service query parameter must be specified - only smart client git protocol is supported.",
      });
    }
    if (supportedServices.indexOf(req.query.service) < 0) {
      return res.status(403).json({
        status: 403,
        message: `Unsupported service "${req.query.service}.`,
      });
    }
    const refs = await repository.getRefs(req);
    res.status(200);
    res.set("content-type", `application/x-${req.query.service}-advertisement`);
    res.set("cache-control", "no-cache");
    res.write(toPktLine(`# service=${req.query.service}`, tools.LF));
    res.write(tools.FlushPkt);
    let caps = [SupportedCapabilities];
    const headRef = await repository.getHeadRef(req);
    if (headRef && headRef != "") {
      caps.push(`symref=HEAD:${headRef}`);
    }
    const _caps = caps.join(" ");
    if (!refs || refs.length < 2) {
      // tools.debug("write ref", tools.ZeroId, " capabilities^{}", tools.Zero, _caps);
      res.write(toPktLine(tools.ZeroId, " capabilities^{}", tools.Zero, _caps, tools.LF));
    } else {
      // tools.debug("write ref", refs[0].sha, refs[0].ref);
      let first = true;
      for (let i = 0; i < refs.length; i++) {
        if (refs[i].ref == null || refs[i].sha == null || refs[i].ref == "" || refs[i].sha == "") continue;
        if (first) {
          // tools.debug("write ref", refs[i].sha, refs[i].ref, _caps);
          res.write(toPktLine(refs[i].sha, " ", refs[i].ref, tools.Zero, _caps, tools.LF));
          first = false;
        } else {
          // tools.debug("write ref", refs[i].sha, refs[i].ref);
          res.write(toPktLine(refs[i].sha, " ", refs[i].ref, tools.LF));
        }

      }
    }
    res.write(tools.FlushPkt);
    res.end();
  } catch (error) {
    tools.debug('Error handling GetRefs:', error.message);
    if (res != null) {
      res.write(toPktLinesWithBand(tools.ErrorBand, error.message));
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    }
    return;
  }
}

export async function handlePost(repository, service, req, res) {
  try {
    const starttime = Date.now();
    tools.logMemoryUsage("handlePost " + service, starttime);
    let decompressStream = null;
    if (req.headers["content-encoding"] === "gzip") {
      decompressStream = zlib.createGunzip();
      req.pipe(decompressStream);
    }
    const stream = decompressStream ? decompressStream : req;
    try {
      let state = {
        res,
        req,
        repository,
        service,
        buffer: Buffer.alloc(0),
        bufferLength: 0,
        start: 0,
        stage: tools.Stages.Initial,
        commands: [],
        isShallow: false,
        depth: -1,
        objects: {},
        promises: [],
        lastbufferLength: undefined,
        skipcounter: 0
      }

      // for await (const chunk of stream) {
      //   if (state.bufferLength + chunk.length > state.buffer.length) {
      //     // Expand the buffer if it's too small to fit the new chunk
      //     let newBuffer = Buffer.alloc(Math.max(state.buffer.length * 2, state.bufferLength + chunk.length));
      //     state.buffer.copy(newBuffer);
      //     state.buffer = newBuffer;
      //   }
      //   state.stage = tools.Stages.PktLine;
      //   chunk.copy(state.buffer, state.bufferLength);
      //   state.bufferLength += chunk.length;
      // }

      const transform = new GitProtocolTransform({ repository, service, state });
      stream.pipe(transform);
      await new Promise((resolve, reject) => {
        transform.on('error', reject);
        transform.on('finish', resolve);
      });

      // https://git-scm.com/docs/protocol-v2
      while (state.stage !== tools.Stages.Final) {
        switch (state.stage) {
          case tools.Stages.PktLine: {
            readPktLine(state);
            break;
          }
          case tools.Stages.PackHeader: {
            // https://git-scm.com/docs/pack-format
            readPackHeader(state);
            if (state.requestedCapabilities != null && state.requestedCapabilities.indexOf("report-status") > -1) {
            }

            break;
          }
          case tools.Stages.PackData: {
            // // https://git-scm.com/docs/pack-format
            await readObject(state);
            break;
          }
          case tools.Stages.PackChecksum: {
            parsePackChecksum(state);
            break;
          }
          case tools.Stages.Final: {
            break;
          }
          case tools.Stages.Error: {
            break;
          }
        }

      }

      if (state.stage !== tools.Stages.Final) {
        throw new Error("Protocol error. Unexpected end of input.");
      }
      const bufferlength = state.bufferLength - state.start;
      if (bufferlength != 0) {
        throw new Error(`Protocol error. Unexpected ${bufferlength} bytes left in the buffer.`);
      }

      tools.logMemoryUsage(service, starttime);
      if (service === "git-upload-pack") {
        await sendWantedObjects(req, res, state);
      } else {
        await repository.receivePack(null, state.commands, Object.values(state.objects));
        // https://git-scm.com/docs/pack-protocol/2.2.0#_report_status
        // https://mincong.io/2018/05/04/git-and-http/
        if (state.requestedCapabilities != null && state.requestedCapabilities.includes("report-status")) {
          res.write(toPktLinesWithBand(tools.DataBand, toPktLine("unpack ok\n")));
          // @ts-ignore
          var refs = state.commands.filter(x => x.command === "create" || x.command === "update" || x.command === "delete").map(x => x.ref)
          refs = refs.filter((v, i, a) => a.indexOf(v) === i);
          for (const ref of refs) {
            res.write(toPktLinesWithBand(tools.DataBand, toPktLine(`ok ${ref}\n`)));
          }
          res.write(toPktLinesWithBand(tools.DataBand, tools.FlushPkt));
        }
      }

      // Send final response back to client
      if (!res.headersSent) {
        res.writeHead(200);
      }
      // End the response with a flush packet to indicate the end of sideband communication
      res.write(tools.FlushPkt);
      // is client still connected?
      if (!res.socket.destroyed) {
        res.end();
      }
      tools.debug("POST completed")
    } catch (error) {
      tools.debug('Error handling POST:', error.message);
      if (res != null) {
        res.write(toPktLinesWithBand(tools.ErrorBand, error.message));
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      }
      return;
    }
  } catch (error) {
    tools.debug('Error handling POST:', error.message);
    if (res != null) {
      res.write(toPktLinesWithBand(tools.ErrorBand, error.message));
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    }
    return;
  } finally {
  }
}


class GitProtocolTransform extends Transform {
  constructor(options) {
    super();
    this.state = options.state;
  }

  async _transform(chunk, encoding, callback) {
    try {
      if (this.state.bufferLength + chunk.length > this.state.buffer.length) {
        let currentsize = this.state.buffer.length;
        // let newBuffer = Buffer.alloc(Math.max(this.state.buffer.length * 2, this.state.bufferLength + chunk.length));
        const addMB = 10 * 1024 * 1024;
        let newBuffer = Buffer.alloc(Math.max(this.state.buffer.length + addMB, this.state.bufferLength + chunk.length));
        this.state.buffer.copy(newBuffer);
        this.state.buffer = null; // symbol for garbage collection
        this.state.buffer = newBuffer;
        if (currentsize > 0) {
          tools.logMemoryUsage(`expanded buffer from ${tools.formatBytes(currentsize)} to ${tools.formatBytes(this.state.buffer.length)}`);
        }
      }
      chunk.copy(this.state.buffer, this.state.bufferLength);
      this.state.bufferLength += chunk.length;
      if (this.state.stage == tools.Stages.Initial) {
        this.state.stage = tools.Stages.PktLine;
      }
      await this.processStages();
      callback();
    } catch (error) {
      callback(error);
    }
  }

  async processStages() {
    let bufferlength = this.state.bufferLength - this.state.start;
    let postBufferlength = this.state.bufferLength - this.state.start;
    do {
      bufferlength = this.state.bufferLength - this.state.start;
      if (this.state.stage == tools.Stages.PktLine) {
        readPktLine(this.state);
      }
      if (this.state.stage == tools.Stages.PackHeader) {
        readPackHeader(this.state);
      }
      if (this.state.stage == tools.Stages.PackData) {
        await readObject(this.state);
      }
      postBufferlength = this.state.bufferLength - this.state.start;
    } while (bufferlength != postBufferlength);
    // tools.logMemoryUsage(`processStages ${this.state.stage} commands ${this.state.commands.length} objects ${this.state.numObjects}`);
  }

  _flush(callback) {
    try {
      callback();
    } catch (error) {
      callback(error);
    }
  }
}

