const { GridFSBucket } = require('mongodb');
const GitRepository = require('./GitRepository');
const { debug } = require('./protocol');
const _acl = [
  {
    "rights": 65535,
    "_id": "5a1702fa245d9013697656fb",
    "name": "admins"
  }];
class MongoGitRepository extends GitRepository {
  /*
  * @param {import('mongodb').Db} db
  * @param {string} collectionname
  * @param {string} repoName
  */
  constructor(db, collectionname, repoName) {
    super();
    /**
     * @type {import('mongodb').Db}
     */
    this.db = db;
    this.uploadasync = true; // if true, will not fail on upload if something goes wrong
    this.collectionname = collectionname;
    this.collection = this.db.collection(this.collectionname);
    this.bucketName = this.repoName.split("/").join("_").split("@").join("_");
    this.bucket = new GridFSBucket(this.db, { bucketName: this.repoName});
    this.headref = undefined;
  }

  async DeleteRepo() {
    await this.collection.deleteMany({ repo: this.repoName });
    await this.bucket.drop();
  }

  async GetBranches() {
    var arr = await this.collection.find({ repo: this.repoName, _type: 'hash' }).toArray()
    return arr.filter(x => x.ref != 'HEAD').map(x => ({ name: x.ref, sha: x.sha }));
    // return arr.filter(x => x.ref != 'HEAD').map(x => ({ name: x.ref.replace('refs/heads/', ''), sha: x.sha }));
  }

  async parseTree(tree, recursive) {
    if(tree.objectType != 'tree') throw new Error(`${tree.sha} is not a tree. (${tree.objectType})`)
    const treedata = tree.data;
    const entries = [];
    let offset = 0;
    while (offset < treedata.length) {
      let spaceIndex = treedata.indexOf(' ', offset);
      let mode = parseInt(treedata.toString('utf8', offset, spaceIndex));
      offset = spaceIndex + 1;

      let nullIndex = treedata.indexOf('\0', offset);
      let filename = treedata.toString('utf8', offset, nullIndex);
      offset = nullIndex + 1;

      let sha1 = treedata.slice(offset, offset + 20).toString('hex');
      offset += 20;

      if(mode == 40000 && recursive == true) {
        try {
          const subobj = await this.getObject(undefined, sha1);
          const subtree = await this.parseTree(subobj)
          entries.push({ mode, name: filename, sha: sha1, subtree });
        } catch (error) {
          console.error(error.message);
        }
      } else {
        entries.push({ mode, name: filename, sha: sha1 });
      }
      
      
    }
    return entries;
  }
  parseCommit(commit) {
    if(commit.objectType != 'commit') throw new Error(`${commit.sha}is not a commit. (${commit.objectType})`)
    const commitdata = commit.data.toString('utf8').split('\n');
    const tree = commitdata[0].split(' ')[1];
    const parent = commitdata[1].split(' ')[1];
    const author = commitdata[2].split(' ')[1];
    const committer = commitdata[3].split(' ')[1];
    const message = commitdata.slice(4).join('\n');
    return { tree, parent, author, committer, message };
  }

  async GetTree(sha, recursive) {
    var commit = await this.getObject(null, sha);
    var _commit = this.parseCommit(commit);
    var tree = await this.getObject(null, _commit.tree);
    return await this.parseTree(tree, recursive);
  }

  async getRefs(req) {
    var arr = await this.collection.find({ repo: this.repoName, _type: 'hash' }).toArray()
    return arr;
  }
  async storeObject(object, metadata) {
    const filename = `blob_${object.sha.toString('hex')}`;
    const stream = this.bucket.openUploadStream(filename, {
      metadata: metadata,
      contentType: 'application/git-' + metadata.objecttype
    });
    stream.on('error', (error) => {
      console.error('Error storing object:', error);
    });
    stream.end(object.data);
    await new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject); // Ensure promise is rejected on error
    });
  
    let id = stream.id.toString();
    // console.log('Object stored:', filename, id);
    return id;
  }
  async getHeadRef(req) {
    if(this.headref != null) return this.headref;
    var arr = await this.collection.find({ repo: this.repoName, ref: 'HEAD', _type: 'hash' }).toArray()
    if (arr == null || arr.length == 0) {
      return undefined;
    }
    return arr[0].headref;
  }

  async receivePack(req, commands, objects) {
    let refs = [];
    const _modified = new Date();
    const _created = new Date();
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i];
      if (this.isZeroId(command.destId)) {
        // console.log('DELETE', 'ref', command.ref);
        await this.collection.deleteOne({ repo: this.repoName, ref: command.ref })
      } else {
        // console.log('UPDATE', 'ref', command.ref, 'sha', command.destId);
        await this.collection.updateOne({ repo: this.repoName, ref: command.ref }, { $set: { repo: this.repoName, ref: command.ref, name: command.ref + " " + command.destId, sha: command.destId, _type: 'hash', _acl, _created, _modified } }, { upsert: true })
        refs.push({ ref: command.ref, sha: command.destId });
      }
    };
    // var refs = await this.collection.find({ repo: this.repoName, _type: 'hash' }).toArray()
    for (let i = 0; i < objects.length; i++) {
      const object = objects[i];
      const updatedoc = { repo: this.repoName, name: object.objectType + " " + object.sha.toString('hex'), sha: object.sha.toString('hex'), _type: 'object', objecttype: object.objectType, _acl, _created, _modified }
      if(this.uploadasync) {
        this.storeObject(object, updatedoc).then(()=> {
          console.log('UPLOAD', 'sha', object.sha.toString('hex'));
        }).catch((e)=> {
          console.error(new Error(`Error uploading sha ${object.sha.toString('hex')} : ${e.message}`));
        });
      } else {
        await this.storeObject(object, updatedoc);
        console.log('UPLOAD', 'sha', object.sha.toString('hex'));
      }
    }
    if(this.headref == null) {
      if (refs.find(x => x.ref == 'HEAD') == null) {
        var headsha = undefined;
        for (let i = 0; i < refs.length; i++) {
          if (refs[i].ref == `refs/heads/master` || refs[i].ref == `refs/heads/main`) {
            this.headref = refs[i].ref;
            headsha = refs[i].sha;
          }
        }
        if (this.headref) {
          // console.log('UPDATE', 'ref', 'HEAD', 'sha', headsha, 'headref', this.headref);
          await this.collection.updateOne({ repo: this.repoName, ref: 'HEAD' }, { $set: { repo: this.repoName, name: 'HEAD ' + this.headref, ref: 'HEAD', headref: this.headref, sha: headsha, _type: 'hash', _acl, _created, _modified } }, { upsert: true })
        }
      } else {
        var b = true;
      }
    }
    debug('REFS', refs);
  }
  async getObject(req, sha) {
    try {
      console.log('GET OBJECT', sha);
      var file = await this.db.collection(this.repoName + '.files').findOne({ "filename" : `blob_${sha}` });
      if(file == null) throw new Error(`Blop with sha1 ${sha} was not found`)
      // const downloadStream = this.bucket.openDownloadStreamByName(`blob_${sha}`);
      var id = file._id.toString();
      const downloadStream = this.bucket.openDownloadStream(file._id);
      let buffer = Buffer.alloc(0); 
      for await (const chunk of downloadStream) {
        // buffer = buffer ? Buffer.concat([buffer, chunk]) : chunk;
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
  
}

module.exports = MongoGitRepository;
