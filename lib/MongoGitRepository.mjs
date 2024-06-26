import { GridFSBucket, ObjectId } from "mongodb";
import { tools, GitRepository } from "./index.mjs";
import deflate from 'pako/lib/deflate.js'
import inflate from 'pako/lib/inflate.js'
import fs from 'fs';
import os from 'os';
export class MongoGitRepository extends GitRepository {
  db;
  uploadasync = false;
  repocollectionname = "";
  repocollection;
  collectionname = "";
  collection;
  repoName = "";
  bucketName = "";
  bucket;
  zlib = true;
  generateChildren = false;
  usefilecache = true;

  _acl = [
    {
      "rights": 65535,
      "_id": "5a1702fa245d9013697656fb",
      "name": "admins"
    }];

  /*
  * @param {import("mongodb").Db} db
  * @param {string} collectionname
  * @param {string} repoName
  */
  constructor(db, repocollectionname, repoName) {
    super();
    /**
     * @type {import("mongodb").Db}
     */
    this.db = db;
    this.uploadasync = false; // if true, will not fail on upload if something goes wrong
    this.repocollectionname = repocollectionname;
    this.repocollection = this.db.collection(this.repocollectionname);
    this.repoName = repoName;
    this.bucketName = this.repoName.split("/").join("_").split("@").join("_");
    this.bucket = new GridFSBucket(this.db, { bucketName: this.bucketName });
    this.collection = this.db.collection(this.bucketName);

    this.collection.createIndex({ sha: 1 }, { unique: true });
    this.collection.createIndex({ "related_shas": 1 });

    this.headref = undefined;
  }
  /**
   * Delete the repository (repo elements and mongodb gridfs bucket)
   * @returns {Promise<void>}
   */
  async DeleteRepo() {
    await this.repocollection.deleteMany({ repo: this.repoName });
    await this.collection.drop();
    await this.bucket.drop();
  }
  /**
   * Get the list of refs (branches and tags) in the repository
   * @param req {import("express").Request}
   * @returns {Promise<{ref: string, sha: string}[]>}
   */
  async getRefs(req) {
    var arr = await this.repocollection.find({ repo: this.repoName, _type: "hash" }).toArray()
    return arr;
  }
  /**
 * Get the HEAD ref of the repository (default branch or current branch) 
 * @param req {import("express").Request}
 * @returns {Promise<string>}
 */
  async getHeadRef(req) {
    if (this.headref != null) return this.headref;
    var arr = await this.repocollection.find({ repo: this.repoName, ref: "HEAD", _type: "hash" }).toArray()
    if (arr == null || arr.length == 0) {
      return undefined;
    }
    this._acl = arr[0]._acl;
    return arr[0].headref;
  }
  /**
   * Called when a client sends a pack of objects to the server
   * @param {import("express").Request}
   * @param {any[]} commands 
   * @param {any[]} objects 
   */
  async receivePack(req, commands, objects) {
    console.time("receivePack");
    tools.logMemoryUsage("begin", "receivePack");
    const starttime = new Date();
    let objectCount = 0;
    try {
      let refs = [];
      const _modified = new Date();
      const _created = new Date();
      if (this.headref == null) {
        let headsha = undefined;
        let headref = undefined;
        for (let i = 0; i < commands.length; i++) {
          if (commands[i].ref == "HEAD" && !tools.isZeroId(commands[i].destId)) {
            headsha = commands[i].destId;
            headref = commands[i].ref;
          }
        }
        if (headsha == null || headsha == "") {
          for (let i = 0; i < commands.length; i++) {
            if (this.headref == null || this.headref == "") {
              if ((commands[i].ref.startsWith("refs/heads/master") || commands[i].ref.startsWith("refs/heads/main")) && !tools.isZeroId(commands[i].destId)) {
                this.headref = commands[i].ref;
                headsha = commands[i].destId;
              }
            }
          }
        }
      }
      for (let i = 0; i < commands.length; i++) {
        const command = commands[i];
        if (tools.isZeroId(command.destId)) {
          tools.debug("DELETE", "ref", command.ref);
          await this.repocollection.deleteOne({ repo: this.repoName, ref: command.ref })
        } else {
          tools.debug("UPDATE", "ref", command.ref, "sha", command.destId);
          await this.upsertRef(command.ref, command.destId);
          refs.push({ ref: command.ref, sha: command.destId });
        }
      };

      tools.logMemoryUsage("after heads parsed", "receivePack");

      const bulkInsertObjects = [];
      const largeObjects = [];

      while (objects.length > 0) {
        const batch = objects.splice(0, tools.batchSize);
        for (const object of batch) {
          objectCount++;
          const updatedoc = { repo: this.repoName, name: object.objectType + " " + object.sha.toString("hex"), sha: object.sha.toString("hex"), _type: tools.ObjectTypes[object.objectType], objecttype: object.objectType, _acl: this._acl, _created, _modified };
          updatedoc.size = object.data.length;
          await this.preProcessObject(object, updatedoc)

          if (updatedoc.size < 2 * 1024 * 1024) { // Less than 2MB
            updatedoc.zlib = this.zlib;
            // updatedoc.zlib = false;
            const dataToStore = updatedoc.zlib ? deflate.deflate(object.data) : object.data;
            bulkInsertObjects.push({ ...updatedoc, data: dataToStore });
          } else {

            largeObjects.push({ object, updatedoc });
          }
        }

        if (bulkInsertObjects.length > 0) {
          try {
            await this.collection.insertMany(bulkInsertObjects);
          } catch (error) {
            console.error(error);
          }
          bulkInsertObjects.length = 0; // Clear the array
        }

        for (const { object, updatedoc } of largeObjects) {
          await this.storeObject(object, updatedoc);
        }
        largeObjects.length = 0; // Clear the array

        if (objectCount % 1000 == 0 && objectCount > 0) {
          const msperobject = (new Date() - starttime) / objectCount;
          // console.timeLog("receivePack", "objects", objectCount, "( ", Math.round(msperobject), "ms per object )");
          tools.logMemoryUsage(`objects objectCount ( ${Math.round(msperobject)}ms per object )`, "receivePack");
        }
      }
      if (objectCount > 0) {
        this.postProcess();
      }
    } finally {
      // console.timeLog("receivePack", "objects", objectCount);
      tools.logMemoryUsage(`complete`);
      console.timeEnd("receivePack");
    }
  }
  postProcessing = false;
  async postProcess() {
    if (!this.generateChildren) return;
    if (this.postProcessing) return;
    this.postProcessing = true;
    tools.logMemoryUsage(`Begin post processing`);
    try {
      const cursor = this.collection.find({ repo: this.repoName, objecttype: 1, children: { $exists: false } });
      for await (const doc of cursor) {
        doc.children = await this.getUploadPack([doc.sha], null, true);
        tools.debug(`Updating ${doc.sha} as having ${doc.children.length} children objects`);
        await this.collection.updateOne({ _id: doc._id }, { $set: { children: doc.children } });
      }
    } catch (error) {
      console.error(error);
    }
    tools.logMemoryUsage(`Completed post processing`);
    this.postProcessing = false;
  }
  async preProcessObject(object, metadata) {
    if (object.objectType == 1 || object.objectType == "commit") {
      const commit = tools.parseCommit(object);
      metadata.parents = commit.parents;
      metadata.tree = commit.tree;
      metadata.author = commit.author;
      metadata.committer = commit.committer;
      metadata.message = commit.message;
      if (commit.date != null) {
        metadata._created = commit.date;
        metadata._modified = commit.date;
      }
      metadata.related_shas = [metadata.tree];
    }
    if (object.objectType == 4 || object.objectType == "tag") {
      const tag = tools.parseTag(object);
      metadata.tree = tag.object;
      metadata.tagger = tag.tagger;
      metadata.message = tag.message;
      metadata.related_shas = [tag.object];
    }
    if (object.objectType == 2 || object.objectType == "tree") {
      const entries = tools.parseTree(object);
      metadata.entries = entries;
      metadata.related_shas = entries.map(entry => entry.sha);
    }
  }

  async getObjectMeta(sha) {
    // Check if the object is stored in the normal collection
    const normalCollectionObject = await this.collection.findOne({ sha }, { projection: { objecttype: 1, size: 1, parents: 1, tree: 1, entries: 1, children: 1 } });
    if (normalCollectionObject == null) {
      throw new Error(`Object ${sha} not found.`);
    }
    normalCollectionObject["sha"] = sha;
    if (normalCollectionObject.data?.buffer != null) {
      normalCollectionObject.data = normalCollectionObject.data.buffer;
    }
    const object = {
      sha,
      objectType: normalCollectionObject.objecttype,
      size: normalCollectionObject.size,
      data: normalCollectionObject.data
    };
    if (normalCollectionObject.children != null) {
      object.children = normalCollectionObject.children;
    }
    if (object.objectType == 1 || object.objectType == "commit") {
      object.parents = normalCollectionObject.parents;
      object.tree = normalCollectionObject.tree;
    }
    if (object.objectType == 4 || object.objectType == "tag") {
      object.tree = normalCollectionObject.tree;
    }
    if (object.objectType == 2 || object.objectType == "tree") {
      object.entries = normalCollectionObject.entries;
    }
    if (normalCollectionObject.zlib && object.data != null) {
      object.data = Buffer.from(inflate.inflate(object.data));
    }
    // tools.debug("GET METADATA", sha, tools.ObjectTypes[object.objectType]);
    return object;
  }
  async getObjectData(file) {
    try {
      if (file.data != null) {
        return file;
      }
      if (file.fileid == null || file.fileid == "") {
        // Check if the object is stored in the normal collection
        const normalCollectionObject = await this.collection.findOne({ sha: file.sha });
        if (normalCollectionObject == null) {
          throw new Error(`Object ${file.sha} not found.`);
        }
        if (normalCollectionObject.children != null) {
          file.children = normalCollectionObject.children;
        }
        file.fileid = normalCollectionObject.fileid;
        if (file.fileid == null || file.fileid == "") {
          if (normalCollectionObject.data) {
            if (normalCollectionObject.data == null) {
              throw new Error(`Object ${file.sha} data is empty`);
            } else {
              if (normalCollectionObject.data.buffer != null) {
                normalCollectionObject.data = normalCollectionObject.data.buffer
              }
            }
            let data = normalCollectionObject.data;
            if (normalCollectionObject.zlib === true) {
              data = Buffer.from(inflate.inflate(data));
            }
            // tools.debug("GET OBJECT", file.sha, tools.ObjectTypes[normalCollectionObject.objecttype], normalCollectionObject.size, "bytes");
            file.data = data;
            return file;
          }
        }
      }
      if (file.fileid == null || file.fileid == "") {
        throw new Error(`Object ${file.sha} not found in GridFS.`);
      }
      const gridFile = await this.db.collection(this.bucketName + ".files").findOne({ _id: new ObjectId(file.fileid) });
      if (!gridFile) {
        throw new Error(`Object ${file.sha} not found in GridFS.`);
      }

      const downloadStream = this.bucket.openDownloadStream(gridFile._id);
      let buffer = Buffer.alloc(0);
      for await (const chunk of downloadStream) {
        buffer = Buffer.concat([buffer, chunk]);
      }
      if (gridFile.metadata.zlib) {
        buffer = Buffer.from(inflate.inflate(buffer));
      }
      const data = buffer;
      file.size = data.length;
      // tools.debug("GET OBJECT", file.sha, tools.ObjectTypes[gridFile.metadata.objecttype], file.size, "bytes");
      if (data == null || file.size == 0) {
        throw new Error(`Object ${file.sha} data is empty`);
      }
      file.data = data;
      return file;
    } catch (error) {
      // tools.debug("GET OBJECT", file.sha);
      throw new Error(`Object ${file.sha} not found. ${error.message}`);
    }
  }
  savefile(object) {
    if (this.usefilecache == false) return;
    const sha = object.sha.toString("hex");
    const folder = os.tmpdir() + "/" + this.bucketName + "/" + sha.substring(0, 2);
    const filename = folder + "/" + sha.substring(2) + "." + tools.ObjectTypes[object.objectType];
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }
    if (!fs.existsSync(filename)) {
      fs.writeFileSync(filename, object.data);
    }
  }
  getfile(sha) {
    if (this.usefilecache == false) return null;
    const filename = os.tmpdir() + "/" + this.bucketName + "/" + sha.substring(0, 2) + "/" + sha.substring(2);
    // does object exists in os.tmpdir() ?
    if (fs.existsSync(filename + ".blob")) {
      let data = fs.readFileSync(filename + ".blob");
      // tools.debug("GET OBJECT", sha, "blob", data.length, "bytes");
      return {
        objectType: "blob",
        data: data
      };
    }
    if (fs.existsSync(filename + ".tree")) {
      let data = fs.readFileSync(filename + ".tree");
      // tools.debug("GET OBJECT", sha, "tree", data.length, "bytes");
      return {
        objectType: "tree",
        data: data
      };
    }
    if (fs.existsSync(filename + ".commit")) {
      let data = fs.readFileSync(filename + ".commit");
      // tools.debug("GET OBJECT", sha, "commit", data.length, "bytes");
      return {
        objectType: "commit",
        data: data
      };
    }
    if (fs.existsSync(filename + ".tag")) {
      let data = fs.readFileSync(filename + ".tag");
      // tools.debug("GET OBJECT", sha, "tag", data.length, "bytes");
      return {
        objectType: "tag",
        data: data
      };
    }
    return null;
  }
  /**
   * Get an object from the repository
   * @param req {import("express").Request}
   * @param sha {string} sha of the object
   * @returns {Promise<{objectType: string, data: Buffer}>}
   */
  async getObject(req, sha) {
    const cache = this.getfile(sha);
    if (cache != null) return cache;

    try {
      // Check if the object is stored in the normal collection
      const normalCollectionObject = await this.collection.findOne({ sha });
      if (normalCollectionObject) {
        if (normalCollectionObject.data) {
          if (normalCollectionObject.data.buffer != null) {
            normalCollectionObject.data = normalCollectionObject.data.buffer
          }
          let data = normalCollectionObject.data;
          let children = undefined;
          if (normalCollectionObject.children != null) {
            children = normalCollectionObject.children;
          }
          if (normalCollectionObject.zlib === true) {
            data = Buffer.from(inflate.inflate(data));
          }
          tools.debug("GET OBJECT", sha, tools.ObjectTypes[normalCollectionObject.objecttype], normalCollectionObject.size, "bytes");
          const result = {
            objectType: normalCollectionObject.objecttype,
            children: children,
            data: data,
            sha: sha
          }
          this.savefile(result);
          return result;
        } else if (normalCollectionObject.fileid) {
          const file = await this.db.collection(this.bucketName + ".files").findOne({ _id: new ObjectId(normalCollectionObject.fileid) });
          if (!file) {
            throw new Error(`Object ${sha} not found in GridFS.`);
          }

          const downloadStream = this.bucket.openDownloadStream(file._id);
          let buffer = Buffer.alloc(0);
          for await (const chunk of downloadStream) {
            buffer = Buffer.concat([buffer, chunk]);
          }
          if (file.metadata.zlib) {
            buffer = Buffer.from(inflate.inflate(buffer));
          }
          const data = buffer;
          tools.debug("GET OBJECT", sha, tools.ObjectTypes[file.metadata.objecttype], normalCollectionObject.size, "bytes");
          const result = {
            objectType: file.metadata.objecttype,
            data: data,
            sha: sha
          }
          this.savefile(result);
          return result;
        }
      }
      throw new Error(`Object ${sha} not found.`);
    } catch (error) {
      tools.debug("GET OBJECT", sha);
      throw new Error(`Object ${sha} not found. ${error.message}`);
    }
  }
  /**
   * Store an object in the repository
   * @param object {any} object to store
   * @param metadata {any} metadata to store with the object
   * @returns {Promise<string>} id of the stored object
   */
  async storeObject(object, metadata = {}) {
    const sha = object.sha.toString("hex");
    this.savefile(object);

    // Check if the object is stored in the normal collection
    const normalCollectionObject = await this.collection.findOne({ sha });
    if (normalCollectionObject) {
      // tools.debug("UPLOAD", "sha", sha, tools.ObjectTypes[object.objectType], "SKIPPED already exists in normal collection");
      return normalCollectionObject._id.toString();
    }

    if (metadata == null) metadata = {};
    if (metadata._acl == null) metadata._acl = this._acl;
    metadata.zlib = this.zlib;
    if (metadata.zlib == true && object.data.length < 100) {
      metadata.zlib = false;
    }
    await this.preProcessObject(object, metadata);

    metadata.size = object.data.length;
    metadata.repo = this.repoName;
    metadata.name = tools.ObjectTypes[object.objectType] + " " + object.sha.toString("hex");
    metadata.sha = object.sha.toString("hex");
    metadata._type = tools.ObjectTypes[object.objectType];
    metadata.objecttype = object.objectType;
    if (metadata._created == null) metadata._created = new Date();
    if (metadata._modified == null) metadata._modified = new Date();

    const filename = `blob_${object.sha.toString("hex")}`;
    let fileid = null;

    if (metadata.size >= 2 * 1024 * 1024) { // 2MB or larger
      const stream = this.bucket.openUploadStream(filename, {
        metadata: metadata,
        contentType: "application/git-" + tools.ObjectTypes[object.objectType]
      });
      stream.on("error", (error) => {
        console.error("Error storing object:", error);
      });
      if (metadata.zlib == true) {
        stream.end(deflate.deflate(object.data));
      } else {
        stream.end(object.data);
      }
      await new Promise((resolve, reject) => {
        stream.on("finish", () => {
          fileid = stream.id;
          resolve();
        });
        stream.on("error", reject); // Ensure promise is rejected on error
      });
    }

    if (metadata.objecttype == 1 || metadata.objecttype == "commit") {
      const commit = tools.parseCommit(object);
      metadata.parents = commit.parents;
      metadata.tree = commit.tree;
    }
    if (metadata.objectType == 4 || metadata.objectType == "tag") {
      const tag = tools.parseTag(object);
      metadata.tree = tag.object;
    }
    if (metadata.objecttype == 2 || metadata.objecttype == "tree") {
      const entries = tools.parseTree(object);
      metadata.entries = entries;
    }
    const dataToStore = metadata.size < 2 * 1024 * 1024 ? (metadata.zlib ? deflate.deflate(object.data) : object.data) : undefined;
    await this.collection.insertOne({
      ...metadata,
      data: dataToStore,
      fileid: fileid ? fileid.toString() : undefined
    });

    // tools.debug("UPLOAD", "sha", sha, tools.ObjectTypes[object.objectType], "STORED in normal collection with GridFS reference");
    return sha;
  }
  /**
   * Create a tag, and an associated tag object, pointing to the latest commit on the branch
   * @param {string} branch 
   * @param {string} tagName 
   * @param {string} tagger 
   * @param {string} message 
   */
  async createAnnotatedTag(branch, tagName, tagger, message) {
    // Get the SHA of the latest commit on the branch
    const branchRef = `refs/heads/${branch}`;
    const branches = await this.getRefs();
    const branchCommit = branches.find(x => x.ref == branchRef);
    const commitSha = branchCommit.sha;

    // Create the tag object
    const tagObject = tools.createTag({
      object: commitSha,
      type: 'commit',
      tag: tagName,
      tagger: `${tagger} ${Math.floor(Date.now() / 1000)} +0000`,
      message
    });

    // Store the tag object in the repository
    await this.storeObject(tagObject);

    // Update the tag reference
    const tagRef = `refs/tags/${tagName}`;
    await this.upsertRef(tagRef, tagObject.sha);
    tools.debug(`Tag ${tagName} created with SHA ${tagObject.sha}`);
  }
  /**
 * Create a lightweight tag pointing to the latest commit on the branch
 * @param {string} branch 
 * @param {string} tagName 
 */
  async createLightweightTag(branch, tagName) {
    // Get the SHA of the latest commit on the branch
    const branchRef = `refs/heads/${branch}`;
    const branches = await this.getRefs();
    const branchCommit = branches.find(x => x.ref == branchRef);
    const commitSha = branchCommit.sha;

    // Update the tag reference to point directly to the commit SHA
    const tagRef = `refs/tags/${tagName}`;
    await this.upsertRef(tagRef, commitSha);
    tools.debug(`Lightweight tag ${tagName} created with SHA ${commitSha}`);
  }

  async upsertRef(ref, sha) {
    const _modified = new Date();
    const _created = new Date();
    await this.repocollection.updateOne(
      { repo: this.repoName, ref },
      {
        $set: {
          repo: this.repoName,
          ref,
          name: this.repoName + " " + ref,
          sha,
          _type: "hash",
          _modified: _modified
        },
        $setOnInsert: {
          _acl: this._acl,
          _created: _created
        }
      },
      { upsert: true }
    );
    if (ref == "HEAD") {
      return;
    }
    const refs = await this.getRefs();
    let headsha = undefined;
    if (this.headref != null) {
      const exists = refs.find(x => x.ref == this.headref);
      if (exists == null) {
        return;
      }
      headsha = exists.sha;
    }


    if (this.headref == null) {
      headsha = undefined;
      for (let i = 0; i < refs.length; i++) {
        if (refs[i].ref == `refs/heads/master` || refs[i].ref == `refs/heads/main`) {
          this.headref = refs[i].ref;
          headsha = refs[i].sha;
        }
      }
      if (this.headref == null) {
        for (let i = 0; i < refs.length; i++) {
          if (refs[i].ref != `HEAD`) {
            this.headref = refs[i].ref;
            headsha = refs[i].sha;
          }
        }
      }
    }
    if (this.headref != null && headsha != null) {
      tools.debug("UPDATE", "ref", "HEAD", "sha", headsha, "headref", this.headref);
      await this.repocollection.updateOne(
        { repo: this.repoName, ref: "HEAD" },
        {
          $set: { repo: this.repoName, name: this.repoName + " HEAD " + this.headref, headref: this.headref, ref: "HEAD", sha: headsha, _type: "hash", _modified },
          $setOnInsert: {
            _acl: this._acl,
            _created: _created
          }
        },
        { upsert: true })
    } else {
      console.warn(`HEAD ref not found ref: ${ref} headref: ${this.headref} headsha: ${headsha}`);
    }
  }

  async getUploadPack(shas, haves = null, skipparents = false, filters = []) {
    const closure = {};
    if (shas == null) shas = [];
    if (haves == null) haves = [];


    const BATCH_SIZE = 10;
    const MAX_DEPTH = 40;

    if (shas.length == 0 && haves.length == 0) {
      console.time("distinct shas");
      const resultshas = await this.collection.distinct("sha", {});
      console.log("Unique SHA count:", resultshas.length);
      console.timeEnd("distinct shas");
      return resultshas;
    }

    let objecttypes = [1, 2, 3, 4];
    let maxdepth = 9999;
    let depth = 0;
    for(let i = 0; i < filters.length; i++) {
      if (filters[i].split(":")[0] == "blob" && filters[i].split(":")[1] == "none") {
        objecttypes = objecttypes.filter(x => x != 3);
      }
      if (filters[i].split(":")[0] == "tree") {
        if(filters[i].split(":")[1] == "none") {
          objecttypes = objecttypes.filter(x => x != 2);
        } else {
          maxdepth = parseInt(filters[i].split(":")[1]);
        }
      }
    }

    let getshas = [...shas]
    let resultShas = new Set(getshas)
    do {
      console.time(`find ${getshas.length} shas`);
      const commits = await this.collection.find({ sha: { $in: getshas }, objecttype: 1 }).toArray();
      console.timeEnd(`find ${getshas.length} shas`);

      const batchShas = commits.map(commit => commit.sha);
      getshas = commits.map(commit => commit.parents).flat().filter(sha => !closure[sha] && !haves.includes(sha));
      getshas = getshas.filter((v, i, a) => a.indexOf(v) === i);
      // remove duplicates from getshas that are already in resultShas
      getshas = getshas.filter(sha => !resultShas.has(sha));
      console.log("new getshas", getshas.length);

      if(batchShas.length > 0) {
        const pipeline = [
          {
            $match: {
              "sha": { $in: batchShas }
            }
          },
          {
            $graphLookup: {
              from: this.bucketName,
              startWith: "$sha",
              connectFromField: "related_shas",
              connectToField: "sha",
              as: "all_related_documents",
              maxDepth: MAX_DEPTH,
              restrictSearchWithMatch: {
                objecttype: { $in: objecttypes }
              }
            }
          },
          {
            $project: {
              "initial_sha": "$sha",
              "all_related_document_shas": "$all_related_documents.sha"
            }
          }
        ];

        console.time(`aggregate ${batchShas.length} shas`);
        const results = await this.collection.aggregate(pipeline).toArray();
        results.forEach(doc => {
          resultShas.add(doc.initial_sha);
          doc.all_related_document_shas.forEach(sha => resultShas.add(sha));
        });
        console.timeEnd(`aggregate ${batchShas.length} shas`);
      }
      depth++;
    } while (getshas.length > 0 && depth <= maxdepth);

    var resultshas = Array.from(resultShas).concat(shas).filter((v, i, a) => a.indexOf(v) === i);
    return resultshas;

  }
  enqueue(closure, queue, sha, haves) {
    if (sha.length !== 40) {
      throw new Error(`Error. Resolving dependency tree resulted in a sha "${sha}" which is not 40 characters long.`);
    }
    if (haves != null && Array.isArray(haves) && haves.indexOf(sha) > -1) return;
    if (!closure[sha]) {
      queue.push(sha);
    }
  }
  async computeClosure(closure, queue, haves = null, skipparents = false, filters = []) {
    while (queue.length > 0) {
      const batch = queue.splice(0, tools.batchSize);

      await Promise.all(batch.map(async sha => {
        return new Promise(async (resolve, reject) => {
          let object = closure[sha];
          if (!object) {
            try {
              object = await this.getObjectMeta(sha);
              closure[sha] = object;
            } catch (error) {
              console.error(`Error getting object ${sha}: ${error.message}`);
              return resolve(object);
            }
          }
          if (object.children != null && this.generateChildren == true) {
            object.children.forEach(child => this.enqueue(closure, queue, child, haves));
            if (object.parents != null && skipparents == false) {
              object.parents.forEach(parent => this.enqueue(closure, queue, parent, haves));
            }
          } else
            if (object.objectType === "commit" || object.objectType === 1) {
              await this.processCommit(closure, queue, object, haves, skipparents);
            } else if (object.objectType === "tree" || object.objectType === 2) {
              await this.processTree(closure, queue, object, filters);
            } else if (object.objectType === "tag" || object.objectType === 4) {
              await this.processTag(closure, queue, object);
            }
          resolve(object);
        });
      }));
      tools.logMemoryUsage(`computed ${Object.keys(closure).length} objects ${queue.length} in queue`);
    }
  }

  async processCommit(closure, queue, object, haves = null, skipparents = false) {
    if (object.parents != null || object.tree != null) {
      // tools.debug("commit", object.tree);
      this.enqueue(closure, queue, object.tree, haves);
      if (object.parents && object.parents.length > 0 && skipparents == false) {
        object.parents.forEach(parent => this.enqueue(closure, queue, parent, haves));
      } else if (object.tree == null || object.tree == "") {
        throw new Error("Invalid commit object. Missing tree and parent references.");
      }
    } else if (!object.data) {
      await this.getObjectData(object);
      if (object.data == null) {
        await this.getObjectData(object);
      }
      const commit = tools.parseCommit(object);
      // tools.debug("commit", commit.tree);
      this.enqueue(closure, queue, commit.tree, haves);
      if (commit.parents && commit.parents.length > 0 && skipparents == false) {
        commit.parents.forEach(parent => this.enqueue(closure, queue, parent, haves));
      }
    }
  }

  async processTag(closure, queue, object) {
    if (object.tree != null) {
      // tools.debug("commit", object.tree);
      this.enqueue(closure, queue, object.tree);
      return;
    }
    if (!object.data) {
      await this.getObjectData(object);
    }
    const tag = tools.parseTag(object);
    this.enqueue(closure, queue, tag.object);
  }

  async processTree(closure, queue, object, filters) {
    let blop = "";
    if (filters != null && filters.length > 0) {
      if (filters[0].split(":")[0] == "blob" && filters[0].split(":")[1] == "none") {
        blop = "none";
      }
    }


    if (object.entries) {
      object.entries.forEach(item => {
        var type = tools.modes[item.mode]
        if (type == "submodule") {
          // tools.debug("skip submodule", item.name)
          return;
        }
        if (blop == "none" && type == "blob") {
          return;
        }
        if (type == null) {
          var b = true;
        }
        this.enqueue(closure, queue, item.sha)
      }
      );
      return;
    }
    if (!object.data) {
      await this.getObjectData(object);
    }
    const tree = await tools.parseTree(object);
    tree.forEach(item => {
      var type = tools.modes[item.mode]
      if (type == "submodule") {
        // tools.debug("skip submodule", item.name)
        return;
      }
      if (blop == "none" && type == "blob") {
        return;
      }
      if (type == null) {
        var b = true;
      }
      this.enqueue(closure, queue, item.sha)
    });
  }
}
