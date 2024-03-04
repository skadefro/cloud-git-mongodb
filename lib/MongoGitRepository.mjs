import { GridFSBucket } from "mongodb";
import { tools, GitRepository } from "./index.mjs";
const _acl = [
  {
    "rights": 65535,
    "_id": "5a1702fa245d9013697656fb",
    "name": "admins"
  }];
export class MongoGitRepository extends GitRepository {
  db;
  uploadasync = true;
  collectionname = "";
  collection;
  repoName = "";
  bucketName = "";
  bucket;
  headref = "";
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
    this.bucket = new GridFSBucket(this.db, { bucketName: this.bucketName});
    this.headref = undefined;
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
    if(this.headref != null) return this.headref;
    var arr = await this.collection.find({ repo: this.repoName, ref: "HEAD", _type: "hash" }).toArray()
    if (arr == null || arr.length == 0) {
      return undefined;
    }
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
      if (this.isZeroId(command.destId)) {
        tools.debug("DELETE", "ref", command.ref);
        await this.collection.deleteOne({ repo: this.repoName, ref: command.ref })
      } else {
        tools.debug("UPDATE", "ref", command.ref, "sha", command.destId);
        await this.collection.updateOne({ repo: this.repoName, ref: command.ref }, { $set: { repo: this.repoName, ref: command.ref, name: command.ref + " " + command.destId, sha: command.destId, _type: "hash", _acl, _created, _modified } }, { upsert: true })
        refs.push({ ref: command.ref, sha: command.destId });
      }
    };
    for (let i = 0; i < objects.length; i++) {
      const object = objects[i];
      const updatedoc = { repo: this.repoName, name: object.objectType + " " + object.sha.toString("hex"), sha: object.sha.toString("hex"), _type: "object", objecttype: object.objectType, _acl, _created, _modified }
      if(this.uploadasync) {
        this.storeObject(object, updatedoc).then(()=> {
          tools.debug("UPLOAD", "sha", object.sha.toString("hex"));
        }).catch((e)=> {
          console.error(new Error(`Error uploading sha ${object.sha.toString("hex")} : ${e.message}`));
        });
      } else {
        await this.storeObject(object, updatedoc);
        tools.debug("UPLOAD", "sha", object.sha.toString("hex"));
      }
    }
    if(this.headref == null) {
      if (refs.find(x => x.ref == "HEAD") == null) {
        var headsha = undefined;
        for (let i = 0; i < refs.length; i++) {
          if (refs[i].ref == `refs/heads/master` || refs[i].ref == `refs/heads/main`) {
            this.headref = refs[i].ref;
            headsha = refs[i].sha;
          }
        }
        if (this.headref) {
          tools.debug("UPDATE", "ref", "HEAD", "sha", headsha, "headref", this.headref);
          await this.collection.updateOne({ repo: this.repoName, ref: "HEAD" }, { $set: { repo: this.repoName, name: "HEAD " + this.headref, ref: "HEAD", headref: this.headref, sha: headsha, _type: "hash", _acl, _created, _modified } }, { upsert: true })
        }
      }
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
      tools.debug("GET OBJECT", sha);
      var file = await this.db.collection(this.repoName + ".files").findOne({ "filename" : `blob_${sha}` });
      if(file == null) throw new Error(`Blop with sha1 ${sha} was not found`)
      var id = file._id.toString();
      const downloadStream = this.bucket.openDownloadStream(file._id);
      let buffer = Buffer.alloc(0); 
      for await (const chunk of downloadStream) {
        buffer = Buffer.concat([buffer, chunk]);
      }
      const data = Buffer.from(buffer);
      return {
        sha,
        objectType: file.metadata.objecttype,
        data
      };
    } catch (error) {
      throw new Error(`Object ${sha} not found. ${error.message}`);
    }
  }
  /**
   * Store an object in the repository
   * @param object {any} object to store
   * @param metadata {any} metadata to store with the object
   * @returns {Promise<string>} id of the stored object
   */
  async storeObject(object, metadata) {
    const filename = `blob_${object.sha.toString("hex")}`;
    if(metadata == null) metadata = {};
    if(metadata._acl == null) metadata._acl = _acl;
    const stream = this.bucket.openUploadStream(filename, {
      metadata: metadata,
      contentType: "application/git-" + metadata.objecttype
    });
    stream.on("error", (error) => {
      console.error("Error storing object:", error);
    });
    stream.end(object.data);
    await new Promise((resolve, reject) => {
      stream.on("finish", resolve);
      stream.on("error", reject); // Ensure promise is rejected on error
    });
  
    let id = stream.id.toString();
    return id;
  }
}
