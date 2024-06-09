import { GridFSBucket, ObjectId } from "mongodb";
import { tools, GitRepository } from "./index.mjs";
import deflate from 'pako/lib/deflate.js'
import inflate from 'pako/lib/inflate.js'
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

    this.headref = undefined;
    this.zlib = true;
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
    const starttime = new Date();
    let objectCount = 0;
    try {
      let refs = [];
      const _modified = new Date();
      const _created = new Date();
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

      const bulkInsertObjects = [];
      const largeObjects = [];

      while(objects.length > 0) {
        const batch = objects.splice(0, tools.batchSize);
        for (const object of batch) {
          const updatedoc = { repo: this.repoName, name: object.objectType + " " + object.sha.toString("hex"), sha: object.sha.toString("hex"), _type: tools.ObjectTypes[object.objectType], objecttype: object.objectType, _acl: this._acl, _created, _modified };
          if (object.data.length < 2 * 1024 * 1024) { // Less than 2MB
            if (object.objectType == 1 || object.objectType == "commit") {
              const commit = tools.parseCommit(object);
              updatedoc.parents = commit.parents;
              updatedoc.tree = commit.tree;
            }
            if (object.objectType == 2 || object.objectType == "tree") {
              const tree = tools.parseTree(object);
              updatedoc.tree = tree;
            }
            bulkInsertObjects.push({ ...updatedoc, data: object.data });
          } else {
            largeObjects.push({ object, updatedoc });
          }
        }

        if (bulkInsertObjects.length > 0) {
          await this.collection.insertMany(bulkInsertObjects);
          bulkInsertObjects.length = 0; // Clear the array
        }

        for (const { object, updatedoc } of largeObjects) {
          await this.storeObject(object, updatedoc);
        }
        largeObjects.length = 0; // Clear the array

        objectCount += batch.length;
        if(objectCount % 100 == 0) {
          const msperobject = (new Date() - starttime) / objectCount;
          console.timeLog("receivePack", "objects", objectCount, "( ", Math.round(msperobject), "ms per object )");
        }
      }
    } finally {
      console.timeLog("receivePack", "objects", objectCount);
      console.timeEnd("receivePack");
    }
  }
  async getObjectMeta(sha) {
    // Check if the object is stored in the normal collection
    const normalCollectionObject = await this.collection.findOne({ sha });
    if (normalCollectionObject == null) {
      throw new Error(`Object ${sha} not found.`);
    }
    if(normalCollectionObject.data?.buffer != null) {
      normalCollectionObject.data = normalCollectionObject.data.buffer;
    }
    let length = -1;
    if(normalCollectionObject.data != null) {
      length = normalCollectionObject.data.length;
    }
    const object = {
      sha,
      objectType: normalCollectionObject.objecttype,
      size: length,
      data: normalCollectionObject.data
    };
    if(object.objectType == 1 || object.objectType == "commit") {
      object.parents = normalCollectionObject.parents;
      object.tree = normalCollectionObject.tree;
    }
    if(object.objectType == 2 || object.objectType == "tree") {
      object.tree = normalCollectionObject.tree;
    }
    tools.debug("GET METADATA", sha, tools.ObjectTypes[object.objectType]);
    return object;
  }
  async getObjectData(file) {
    try {
      // Check if the object is stored in the normal collection
      const normalCollectionObject = await this.collection.findOne({ sha: file.sha });
      if (normalCollectionObject) {
        if (normalCollectionObject.data) {
          if(normalCollectionObject.data == null) {
            throw new Error(`Object ${file.sha} data is empty`);
          } else {
            if(normalCollectionObject.data.buffer != null) {
              normalCollectionObject.data = normalCollectionObject.data.buffer
            }
          }
          tools.debug("GET OBJECT", file.sha, tools.ObjectTypes[normalCollectionObject.objecttype], normalCollectionObject.data.length, "bytes");
          file.data = normalCollectionObject.data;
          return file;
        } else if (normalCollectionObject.fileid) {
          const gridFile = await this.db.collection(this.bucketName + ".files").findOne({ _id: new ObjectId(normalCollectionObject.fileid) });
          if (!gridFile) {
            throw new Error(`Object ${file.sha} not found in GridFS.`);
          }

          const downloadStream = this.bucket.openDownloadStream(gridFile._id);
          let buffer = Buffer.alloc(0);
          for await (const chunk of downloadStream) {
            buffer = Buffer.concat([buffer, chunk]);
          }
          if (gridFile.metadata.zlib) {
            buffer = inflate.inflate(buffer);
          }
          const data = Buffer.from(buffer);
          tools.debug("GET OBJECT", file.sha, tools.ObjectTypes[gridFile.metadata.objecttype], data.length, "bytes");
          if(data == null || data.length == 0) {
            throw new Error(`Object ${file.sha} data is empty`);
          }
          file.data = data;
          return file;
        }
        throw new Error(`Object ${file.sha} not found.`);
      }

      // If not found in the normal collection, check GridFS
      const downloadStream = this.bucket.openDownloadStream(file._id);
      let buffer = Buffer.alloc(0);
      for await (const chunk of downloadStream) {
        buffer = Buffer.concat([buffer, chunk]);
      }
      if (file.zlib) {
        buffer = inflate.inflate(buffer);
      }
      const data = Buffer.from(buffer);
      tools.debug("GET OBJECT", file.sha, tools.ObjectTypes[file.objectType], data.length, "bytes");
      if(data == null || data.length == 0) {
        throw new Error(`Object ${file.sha} data is empty`);
      }
      file.data = data;
      return file;
    } catch (error) {
      tools.debug("GET OBJECT", file.sha);
      throw new Error(`Object ${file.sha} not found. ${error.message}`);
    }
  }
  /**
   * Get an object from the repository
   * @param req {import("express").Request}
   * @param sha {string} sha of the object
   * @returns {Promise<{objectType: string, data: Buffer}>}
   */
  async getObject(req, sha) {
    try {
      // Check if the object is stored in the normal collection
      const normalCollectionObject = await this.collection.findOne({ sha });
      if (normalCollectionObject) {
        if (normalCollectionObject.data) {
          tools.debug("GET OBJECT", sha, tools.ObjectTypes[normalCollectionObject.objecttype], normalCollectionObject.data.length, "bytes");
          return {
            objectType: normalCollectionObject.objecttype,
            data: normalCollectionObject.data
          };
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
            buffer = inflate.inflate(buffer);
          }
          const data = Buffer.from(buffer);
          tools.debug("GET OBJECT", sha, tools.ObjectTypes[file.metadata.objecttype], data.length, "bytes");
          return {
            objectType: file.metadata.objecttype,
            data: data
          };
        }
        throw new Error(`Object ${sha} not found.`);
      }

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

    // Check if the object is stored in the normal collection
    const normalCollectionObject = await this.collection.findOne({ sha });
    if (normalCollectionObject) {
      tools.debug("UPLOAD", "sha", sha, tools.ObjectTypes[object.objectType], "SKIPPED already exists in normal collection");
      return normalCollectionObject._id.toString();
    }

    if (metadata == null) metadata = {};
    if (metadata._acl == null) metadata._acl = this._acl;
    metadata.zlib = this.zlib;
    if (metadata.zlib == true && object.data.length < 100) {
      metadata.zlib = false;
    }
    metadata.repo = this.repoName;
    metadata.name = tools.ObjectTypes[object.objectType] + " " + object.sha.toString("hex");
    metadata.sha = object.sha.toString("hex");
    metadata._type = tools.ObjectTypes[object.objectType];
    metadata.objecttype = object.objectType;
    if (metadata._created == null) metadata._created = new Date();
    if (metadata._modified == null) metadata._modified = new Date();

    const filename = `blob_${object.sha.toString("hex")}`;
    let fileid = null;

    if (object.data.length >= 2 * 1024 * 1024) { // 2MB or larger
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
    if (metadata.objecttype == 2 || metadata.objecttype == "tree") {
      const tree = tools.parseTree(object);
      metadata.tree = tree;
    }
    await this.collection.insertOne({
      ...metadata,
      data: object.data.length < 2 * 1024 * 1024 ? object.data : undefined,
      fileid: fileid ? fileid.toString() : undefined
    });

    tools.debug("UPLOAD", "sha", sha, tools.ObjectTypes[object.objectType], "STORED in normal collection with GridFS reference");
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
    console.log(`Tag ${tagName} created with SHA ${tagObject.sha}`);
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
    console.log(`Lightweight tag ${tagName} created with SHA ${commitSha}`);
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
    if(ref == "HEAD") {
      return;
    }
    const refs = await this.getRefs();
    let headsha = undefined;
    if (this.headref != null) {
      const exists = refs.find(x => x.ref == this.headref);
      if (exists == null) {
        this.headref = undefined;
      }
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
    } else {
      headsha = refs.find(x => x.ref == this.headref).sha;
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

  /**
   * Get metadata for multiple objects in batch
   * @param {string[]} shas Array of SHAs
   * @returns {Promise<Map<string, any>>} Map of SHA to object metadata
   */
  async getObjectMetaBatch(shas) {
    // Check if the objects are stored in the normal collection
    const normalCollectionObjects = await this.collection.find({
      sha: { $in: shas }
    }).toArray();

    return normalCollectionObjects.map(obj => {
      if(obj.data?.buffer) {
        obj.data = obj.data.buffer;
      }
      let length = -1;
      if(obj.data != null) {
        length = obj.data.length;
      }
      return {
        sha: obj.sha,
        objectType: obj.objecttype,
        size: length,
        data: obj.data
      }
    });
  }
  
    /**
     * Get data for multiple objects in batch
     * @param {any[]} files Array of file objects
     * @returns {Promise<any[]>} Array of file objects with data
     */
    async getObjectDataBatch(files) {
      const dataPromises = files.map(async file => {
        const downloadStream = this.bucket.openDownloadStream(file._id);
        let buffer = Buffer.alloc(0);
        for await (const chunk of downloadStream) {
          buffer = Buffer.concat([buffer, chunk]);
        }
        if (file.zlib) {
          buffer = inflate.inflate(buffer);
        }
        const data = Buffer.from(buffer);
        file.data = data;
        delete file.zlib;
        delete file._id;
        return file;
      });
  
      return Promise.all(dataPromises);
    }
}
