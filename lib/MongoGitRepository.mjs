import { GridFSBucket } from "mongodb";
import { tools, GitRepository } from "./index.mjs";
import deflate from 'pako/lib/deflate.js'
import inflate from 'pako/lib/inflate.js'
export class MongoGitRepository extends GitRepository {
  db;
  uploadasync = true;
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
  constructor(db, collectionname, repoName) {
    super();
    /**
     * @type {import("mongodb").Db}
     */
    this.db = db;
    this.uploadasync = true; // if true, will not fail on upload if something goes wrong
    this.collectionname = collectionname;
    this.collection = this.db.collection(this.collectionname);
    this.repoName = repoName;
    this.bucketName = this.repoName.split("/").join("_").split("@").join("_");
    this.bucket = new GridFSBucket(this.db, { bucketName: this.bucketName });
    this.headref = undefined;
    this.zlib = true;
  }
  /**
   * Delete the repository (repo elements and mongodb gridfs bucket)
   * @returns {Promise<void>}
   */
  async DeleteRepo() {
    await this.collection.deleteMany({ repo: this.repoName });
    await this.bucket.drop();
  }
  /**
   * Get the list of refs (branches and tags) in the repository
   * @param req {import("express").Request}
   * @returns {Promise<{ref: string, sha: string}[]>}
   */
  async getRefs(req) {
    var arr = await this.collection.find({ repo: this.repoName, _type: "hash" }).toArray()
    return arr;
  }
  /**
 * Get the HEAD ref of the repository (default branch or current branch) 
 * @param req {import("express").Request}
 * @returns {Promise<string>}
 */
  async getHeadRef(req) {
    if (this.headref != null) return this.headref;
    var arr = await this.collection.find({ repo: this.repoName, ref: "HEAD", _type: "hash" }).toArray()
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
    let refs = [];
    const _modified = new Date();
    const _created = new Date();
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i];
      if (tools.isZeroId(command.destId)) {
        tools.debug("DELETE", "ref", command.ref);
        await this.collection.deleteOne({ repo: this.repoName, ref: command.ref })
      } else {
        tools.debug("UPDATE", "ref", command.ref, "sha", command.destId);
        await this.upsertRef(command.ref, command.destId);  
        refs.push({ ref: command.ref, sha: command.destId });
      }
    };
    for (let i = 0; i < objects.length; i++) {
      const object = objects[i];
      const updatedoc = { repo: this.repoName, name: object.objectType + " " + object.sha.toString("hex"), sha: object.sha.toString("hex"), _type: "object", objecttype: object.objectType, _acl: this._acl, _created, _modified }
      if (this.uploadasync) {
        this.storeObject(object, updatedoc).then(() => {
          tools.debug("UPLOAD", "sha", object.sha.toString("hex"));
        }).catch((e) => {
          console.error(new Error(`Error uploading sha ${object.sha.toString("hex")} : ${e.message}`));
        });
      } else {
        await this.storeObject(object, updatedoc);
        tools.debug("UPLOAD", "sha", object.sha.toString("hex"));
      }
    }
  }
  async getObjectMeta(sha) {
    var file = await this.db.collection(this.bucketName + ".files").findOne({ "filename": `blob_${sha}` });
    if (file == null) throw new Error(`Blop with sha1 ${sha} was not found`)
    const object = {
      sha,
      objectType: file.metadata.objecttype,
      _id: file._id,
      zlib: file.metadata.zlib
    };
    return object;
  }
  async getObjectData(file) {
    const downloadStream = this.bucket.openDownloadStream(file._id);
    let buffer = Buffer.alloc(0);
    for await (const chunk of downloadStream) {
      buffer = Buffer.concat([buffer, chunk]);
    }
    if (file.zlib == true) {
      buffer = inflate.inflate(buffer);
    }
    const data = Buffer.from(buffer);
    tools.debug("GET OBJECT", file.sha, file.objectType, data.length, "bytes");
    file.data = data;
    delete file.zlib;
    delete file._id;
    return file;
  }
  /**
   * Get an object from the repository
   * @param req {import("express").Request}
   * @param sha {string} sha of the object
   * @returns {Promise<{objectType: string, data: Buffer}>}
   */
  async getObject(req, sha) {
    try {
      const file = await this.getObjectMeta(sha);
      const object = await this.getObjectData(file)
      return object;
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
    var file = await this.db.collection(this.bucketName + ".files").findOne({ "filename": `blob_${sha}` });
    if (file != null) {
      tools.debug("SKIP", "sha", sha, "already exists");
      return file._id.toString();
    }
    const filename = `blob_${object.sha.toString("hex")}`;
    if (metadata == null) metadata = {};
    if (metadata._acl == null) metadata._acl = this._acl;
    metadata.zlib = this.zlib;
    if (metadata.zlib == true && object.data.length < 100) {
      metadata.zlib = false;
    }
    metadata.repo = this.repoName;
    metadata.name = tools.ObjectTypes[object.objectType] + " " + object.sha.toString("hex")
    metadata.sha = object.sha.toString("hex");
    metadata._type = tools.ObjectTypes[object.objectType];
    metadata.objecttype = object.objectType;
    if (metadata._created == null) metadata._created = new Date();
    if (metadata._modified == null) metadata._modified = new Date();
    const stream = this.bucket.openUploadStream(filename, {
      metadata: metadata,
      contentType: "application/git-" + metadata.objecttype
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
      stream.on("finish", resolve);
      stream.on("error", reject); // Ensure promise is rejected on error
    });
    let id = stream.id.toString();
    return id;
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
    await this.collection.updateOne(
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
      await this.collection.updateOne(
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

}
